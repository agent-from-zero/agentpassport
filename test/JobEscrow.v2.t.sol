// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "./Base.t.sol";
import {IJobEscrow} from "../src/interfaces/IJobEscrow.sol";
import {IAgentPassport} from "../src/interfaces/IAgentPassport.sol";
import {JobEscrow} from "../src/JobEscrow.sol";
import {MockIdentityRegistry} from "../src/mocks/Mocks.sol";

/// @dev Identity registry whose ownerOf returns address(0) for unknown ids instead of reverting.
contract LaxIdentityRegistry is MockIdentityRegistry {
    function ownerOf(uint256 agentId) external view override returns (address) {
        return owners[agentId];
    }
}

/// @dev Findings of the security review (docs/SECURITY.md) fixed in JobEscrow v2, one test per
///      finding plus fuzzed invariants.
contract JobEscrowV2Test is BaseTest {
    address internal griefer = makeAddr("griefer");

    function _fundGriefer() internal {
        usdc.mint(griefer, 1_000_000);
        vm.prank(griefer);
        usdc.approve(address(escrow), type(uint256).max);
    }

    // ───────────── F-1: unsolicited jobs cannot mark an agent's passport ─────────────

    function test_F1_unsolicitedJob_refundLeavesPassportUntouched() public {
        _fundGriefer();
        IJobEscrow.OpenParams memory p = _params();
        p.amount = 1; // 0.000001 USDC, returned on refund
        p.deadline = uint64(block.timestamp + 1);
        vm.prank(griefer);
        uint256 jobId = escrow.open(p);
        vm.warp(block.timestamp + 2);

        vm.recordLogs();
        vm.prank(griefer);
        escrow.refund(jobId);

        IAgentPassport.Passport memory pp = passport.passportOf(agentId);
        assertEq(pp.jobsRefunded, 0, "no mark without the agent's acceptance");
        assertEq(pp.firstSeen, 0, "passport never touched");
        assertEq(usdc.balanceOf(griefer), 1_000_000);
        assertEq(uint8(escrow.getJob(jobId).status), uint8(IJobEscrow.Status.Refunded));
        assertEq(vm.getRecordedLogs().length, 2, "JobRefunded + token Transfer only, no Attested");
    }

    function test_F1_unacceptedJob_hirerCanCancelBeforeDeadline() public {
        uint256 jobId = _openJob();
        uint256 before = usdc.balanceOf(hirer);
        vm.prank(hirer);
        escrow.refund(jobId); // no need to wait for the deadline
        assertEq(usdc.balanceOf(hirer), before + PRICE);
        assertEq(passport.passportOf(agentId).jobsRefunded, 0);

        // the agent can no longer take it
        vm.prank(agentWallet);
        vm.expectRevert(abi.encodeWithSelector(IJobEscrow.InvalidStatus.selector, jobId, IJobEscrow.Status.Refunded));
        escrow.accept(jobId);
    }

    function test_F1_acceptedJob_noShow_isRecorded() public {
        uint256 jobId = _openJob();
        vm.expectEmit(true, true, true, true);
        emit IJobEscrow.JobAccepted(jobId, agentId, agentOwner);
        vm.prank(agentOwner);
        escrow.accept(jobId);
        assertEq(escrow.acceptedAt(jobId), block.timestamp);

        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(hirer);
        escrow.refund(jobId);
        assertEq(passport.passportOf(agentId).jobsRefunded, 1, "agent committed and did not deliver");
        assertEq(reputation.count(agentId), 0, "refunds are not mirrored to ERC-8004");
    }

    function test_F1_accept_onlyAgent_once_beforeDeadline() public {
        uint256 jobId = _openJob();
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IJobEscrow.NotAgent.selector, jobId, stranger));
        escrow.accept(jobId);
        vm.prank(hirer);
        vm.expectRevert(abi.encodeWithSelector(IJobEscrow.NotAgent.selector, jobId, hirer));
        escrow.accept(jobId);

        vm.prank(agentWallet);
        escrow.accept(jobId);
        vm.prank(agentWallet);
        vm.expectRevert(abi.encodeWithSelector(IJobEscrow.AlreadyAccepted.selector, jobId));
        escrow.accept(jobId);

        uint256 late = _openJob();
        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(agentWallet);
        vm.expectRevert(abi.encodeWithSelector(IJobEscrow.DeadlinePassed.selector, late, _deadlineOf(late)));
        escrow.accept(late);
    }

    function test_F1_deliver_impliesAcceptance() public {
        uint256 jobId = _openJob();
        assertEq(escrow.acceptedAt(jobId), 0);
        vm.expectEmit(true, true, true, true);
        emit IJobEscrow.JobAccepted(jobId, agentId, agentWallet);
        _deliver(jobId);
        assertEq(escrow.acceptedAt(jobId), block.timestamp);
    }

    function test_F1_acceptThenDeliver_keepsFirstAcceptance() public {
        uint256 jobId = _openJob();
        vm.prank(agentWallet);
        escrow.accept(jobId);
        uint256 t0 = block.timestamp;
        vm.warp(t0 + 1 hours);
        _deliver(jobId);
        assertEq(escrow.acceptedAt(jobId), t0);
        vm.prank(hirer);
        escrow.release(jobId);
        assertEq(passport.passportOf(agentId).jobsSettled, 1);
    }

    // ───────────── F-2: no delivery after the deadline (refund front-running) ─────────────

    function test_F2_deliver_afterDeadline_reverts_hirerRefunds() public {
        uint256 jobId = _openJob();
        vm.prank(agentWallet);
        escrow.accept(jobId);
        uint64 deadline = _deadlineOf(jobId);

        vm.warp(deadline + 1);
        vm.prank(agentWallet);
        vm.expectRevert(abi.encodeWithSelector(IJobEscrow.DeadlinePassed.selector, jobId, deadline));
        escrow.deliver(jobId, keccak256("late"), "ipfs://late");

        vm.prank(hirer);
        escrow.refund(jobId);
        assertEq(uint8(escrow.getJob(jobId).status), uint8(IJobEscrow.Status.Refunded));
    }

    function test_F2_deliver_atDeadline_ok_refundNotYet() public {
        uint256 jobId = _openJob();
        uint64 deadline = _deadlineOf(jobId);
        vm.warp(deadline);
        _deliver(jobId); // inclusive
        assertEq(uint8(escrow.getJob(jobId).status), uint8(IJobEscrow.Status.Delivered));
        vm.prank(hirer);
        vm.expectRevert(abi.encodeWithSelector(IJobEscrow.InvalidStatus.selector, jobId, IJobEscrow.Status.Delivered));
        escrow.refund(jobId);
    }

    /// @dev For any time t: the agent can deliver iff t <= deadline, the hirer can refund an
    ///      accepted job iff t > deadline. The two windows never overlap and leave no gap.
    function testFuzz_F2_deliverAndRefundWindowsPartitionTime(uint64 ttl, uint64 elapsed) public {
        ttl = uint64(bound(ttl, 1, 365 days));
        elapsed = uint64(bound(elapsed, 0, 2 * 365 days));
        IJobEscrow.OpenParams memory p = _params();
        p.deadline = uint64(block.timestamp) + ttl;
        vm.prank(hirer);
        uint256 jobId = escrow.open(p);
        vm.prank(agentWallet);
        escrow.accept(jobId);
        vm.warp(block.timestamp + elapsed);

        uint256 snap = vm.snapshotState();
        vm.prank(agentWallet);
        (bool delivered,) = address(escrow).call(abi.encodeCall(escrow.deliver, (jobId, keccak256("d"), "ipfs://d")));
        vm.revertToState(snap);
        vm.prank(hirer);
        (bool refunded,) = address(escrow).call(abi.encodeCall(escrow.refund, (jobId)));

        assertTrue(delivered != refunded, "exactly one of deliver / refund is possible");
        assertEq(delivered, elapsed <= ttl);
    }

    // ───────────── F-3: bounded review window (dispute arithmetic) ─────────────

    function test_F3_open_rejectsReviewWindowAboveMax() public {
        IJobEscrow.OpenParams memory p = _params();
        p.reviewWindow = escrow.MAX_REVIEW_WINDOW() + 1;
        vm.prank(hirer);
        vm.expectRevert(
            abi.encodeWithSelector(IJobEscrow.BadReviewWindow.selector, p.reviewWindow, escrow.MAX_REVIEW_WINDOW())
        );
        escrow.open(p);
    }

    function test_F3_maxReviewWindow_disputeAndTimeoutReleaseWork() public {
        IJobEscrow.OpenParams memory p = _params();
        p.reviewWindow = escrow.MAX_REVIEW_WINDOW();
        vm.prank(hirer);
        uint256 a = escrow.open(p);
        vm.prank(hirer);
        uint256 b = escrow.open(p);
        _deliver(a);
        _deliver(b);

        vm.warp(block.timestamp + 30 days); // last second of the window
        vm.prank(hirer);
        escrow.dispute(a);
        assertEq(uint8(escrow.getJob(a).status), uint8(IJobEscrow.Status.Disputed));

        vm.warp(block.timestamp + 1);
        vm.prank(stranger);
        escrow.release(b);
        assertEq(uint8(escrow.getJob(b).status), uint8(IJobEscrow.Status.Released));
    }

    // ───────────── F-5: bounded endpoint label ─────────────

    function test_F5_open_rejectsOversizedEndpoint() public {
        IJobEscrow.OpenParams memory p = _params();
        p.endpoint = string(new bytes(257));
        vm.prank(hirer);
        vm.expectRevert(abi.encodeWithSelector(IJobEscrow.EndpointTooLong.selector, 257));
        escrow.open(p);

        p.endpoint = string(new bytes(256)); // the limit itself is fine
        vm.prank(hirer);
        uint256 jobId = escrow.open(p);
        _deliver(jobId);
        vm.warp(block.timestamp + REVIEW + 1);
        vm.prank(stranger);
        escrow.release(jobId);
        assertEq(passport.passportOf(agentId).jobsSettled, 1);
    }

    // ───────────── F-4: registry that returns address(0) for unknown agents ─────────────

    function test_F4_laxRegistry_unknownAgentRejected() public {
        LaxIdentityRegistry lax = new LaxIdentityRegistry();
        JobEscrow e = new JobEscrow(address(lax), address(passport), address(usdc));
        IJobEscrow.OpenParams memory p = _params();
        p.agentId = 42;
        vm.prank(hirer);
        vm.expectRevert(abi.encodeWithSelector(IJobEscrow.UnknownAgent.selector, 42));
        e.open(p);
    }

    // ───────────── misc ─────────────

    function test_version() public view {
        assertEq(escrow.version(), "2");
        assertEq(escrow.MAX_REVIEW_WINDOW(), 30 days);
        assertEq(escrow.MAX_ENDPOINT_LENGTH(), 256);
    }

    /// @dev Whatever a stranger does with jobs the agent never accepted, the agent's passport is
    ///      unchanged and every cent goes back to the stranger.
    function testFuzz_F1_strangerJobsNeverTouchPassport(uint8 n, uint128 amount, uint32 wait) public {
        n = uint8(bound(n, 1, 8));
        amount = uint128(bound(amount, 1, 100_000));
        _fundGriefer();
        uint256 start = usdc.balanceOf(griefer);
        uint256[] memory ids = new uint256[](n);
        IJobEscrow.OpenParams memory p = _params();
        p.amount = amount;
        for (uint256 i; i < n; i++) {
            vm.prank(griefer);
            ids[i] = escrow.open(p);
        }
        vm.warp(block.timestamp + wait);
        for (uint256 i; i < n; i++) {
            vm.prank(griefer);
            escrow.refund(ids[i]);
        }
        IAgentPassport.Passport memory pp = passport.passportOf(agentId);
        assertEq(pp.jobsRefunded + pp.jobsSettled + pp.jobsDisputed, 0);
        assertEq(usdc.balanceOf(griefer), start);
        assertEq(usdc.balanceOf(address(escrow)), 0);
    }

    function _deadlineOf(uint256 jobId) internal view returns (uint64) {
        return escrow.getJob(jobId).deadline;
    }
}

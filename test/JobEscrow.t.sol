// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "./Base.t.sol";
import {IJobEscrow} from "../src/interfaces/IJobEscrow.sol";
import {IAgentPassport} from "../src/interfaces/IAgentPassport.sol";

/// @dev Lifecycle tests for JobEscrow. Happy path first, then each guard.
contract JobEscrowTest is BaseTest {
    // ───────────── open ─────────────

    function test_open_escrowsFundsAndEmits() public {
        uint256 before = usdc.balanceOf(hirer);
        vm.expectEmit(true, true, true, true);
        emit IJobEscrow.JobOpened(
            1, agentId, hirer, address(usdc), PRICE, uint64(block.timestamp + 1 days), _params().specHash, "summarise"
        );
        uint256 jobId = _openJob();

        assertEq(jobId, 1);
        assertEq(escrow.jobCount(), 1);
        assertEq(usdc.balanceOf(hirer), before - PRICE);
        assertEq(usdc.balanceOf(address(escrow)), PRICE);
        IJobEscrow.Job memory j = escrow.getJob(jobId);
        assertEq(uint8(j.status), uint8(IJobEscrow.Status.Open));
        assertEq(j.hirer, hirer);
        assertEq(j.agentId, agentId);
    }

    function test_open_revertsOnUnknownAgent() public {
        IJobEscrow.OpenParams memory p = _params();
        p.agentId = 999;
        vm.prank(hirer);
        vm.expectRevert(abi.encodeWithSelector(IJobEscrow.UnknownAgent.selector, 999));
        escrow.open(p);
    }

    function test_open_revertsOnZeroAmount() public {
        IJobEscrow.OpenParams memory p = _params();
        p.amount = 0;
        vm.prank(hirer);
        vm.expectRevert(IJobEscrow.ZeroAmount.selector);
        escrow.open(p);
    }

    function test_open_revertsOnPastDeadline() public {
        IJobEscrow.OpenParams memory p = _params();
        p.deadline = uint64(block.timestamp);
        vm.prank(hirer);
        vm.expectRevert(IJobEscrow.BadDeadline.selector);
        escrow.open(p);
    }

    // ───────────── deliver ─────────────

    function test_deliver_byAgentWallet() public {
        uint256 jobId = _openJob();
        _deliver(jobId);
        IJobEscrow.Job memory j = escrow.getJob(jobId);
        assertEq(uint8(j.status), uint8(IJobEscrow.Status.Delivered));
        assertEq(j.deliverableHash, keccak256("deliverable"));
        assertEq(j.deliveredAt, uint64(block.timestamp));
    }

    function test_deliver_byAgentOwner() public {
        uint256 jobId = _openJob();
        vm.prank(agentOwner);
        escrow.deliver(jobId, keccak256("x"), "");
        assertEq(uint8(escrow.getJob(jobId).status), uint8(IJobEscrow.Status.Delivered));
    }

    function test_deliver_revertsForStranger() public {
        uint256 jobId = _openJob();
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IJobEscrow.NotAgent.selector, jobId, stranger));
        escrow.deliver(jobId, keccak256("x"), "");
    }

    // ───────────── release ─────────────

    function test_release_byHirer_paysAgentAndAttests() public {
        uint256 jobId = _openJob();
        _deliver(jobId);

        vm.prank(hirer);
        escrow.release(jobId);

        assertEq(usdc.balanceOf(agentWallet), PRICE);
        assertEq(usdc.balanceOf(address(escrow)), 0);
        assertEq(uint8(escrow.getJob(jobId).status), uint8(IJobEscrow.Status.Released));

        IAgentPassport.Passport memory p = passport.passportOf(agentId);
        assertEq(p.jobsSettled, 1);
        assertEq(p.volumeSettled, PRICE);
        assertEq(p.token, address(usdc));
        assertEq(passport.settledBetween(hirer, agentId), 1);

        // Mirrored to ERC-8004 from the passport contract's address (never the agent owner).
        assertEq(reputation.count(agentId), 1);
        (address client,,,,,, bytes32 feedbackHash) = reputation.entries(agentId, 0);
        assertEq(client, address(passport));
        assertEq(feedbackHash, keccak256(abi.encode(address(escrow), jobId)));
    }

    function test_release_byVerifier() public {
        IJobEscrow.OpenParams memory p = _params();
        p.verifier = verifier;
        vm.prank(hirer);
        uint256 jobId = escrow.open(p);
        _deliver(jobId);

        vm.prank(verifier);
        escrow.release(jobId);
        assertEq(usdc.balanceOf(agentWallet), PRICE);
    }

    function test_release_byAnyone_afterReviewWindow() public {
        uint256 jobId = _openJob();
        _deliver(jobId);

        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IJobEscrow.NotAuthorizedToRelease.selector, jobId, stranger));
        escrow.release(jobId);

        vm.warp(block.timestamp + REVIEW + 1);
        vm.prank(stranger);
        escrow.release(jobId);
        assertEq(usdc.balanceOf(agentWallet), PRICE);
    }

    function test_release_revertsIfNotDelivered() public {
        uint256 jobId = _openJob();
        vm.prank(hirer);
        vm.expectRevert(abi.encodeWithSelector(IJobEscrow.InvalidStatus.selector, jobId, IJobEscrow.Status.Open));
        escrow.release(jobId);
    }

    // ───────────── refund ─────────────

    function test_refund_afterDeadline() public {
        uint256 jobId = _openJob();
        uint256 before = usdc.balanceOf(hirer);

        vm.prank(hirer);
        vm.expectRevert();
        escrow.refund(jobId); // deadline not passed

        vm.warp(block.timestamp + 1 days + 1);
        vm.prank(hirer);
        escrow.refund(jobId);

        assertEq(usdc.balanceOf(hirer), before + PRICE);
        assertEq(passport.passportOf(agentId).jobsRefunded, 1);
        assertEq(reputation.count(agentId), 0, "refunds are not mirrored as feedback");
    }

    function test_refund_revertsForNonHirer() public {
        uint256 jobId = _openJob();
        vm.warp(block.timestamp + 2 days);
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(IJobEscrow.NotHirer.selector, jobId, stranger));
        escrow.refund(jobId);
    }

    // ───────────── dispute ─────────────

    function test_dispute_withinWindow_refundsAndAttests() public {
        uint256 jobId = _openJob();
        _deliver(jobId);
        vm.prank(hirer);
        escrow.dispute(jobId);

        assertEq(usdc.balanceOf(hirer), 1_000_000_000);
        assertEq(passport.passportOf(agentId).jobsDisputed, 1);
        assertEq(reputation.count(agentId), 1);
    }

    function test_dispute_revertsAfterWindow() public {
        uint256 jobId = _openJob();
        _deliver(jobId);
        vm.warp(block.timestamp + REVIEW + 1);
        vm.prank(hirer);
        vm.expectRevert();
        escrow.dispute(jobId);
    }

    // ───────────── passkeys ─────────────

    function test_registerPasskey_storesKey() public {
        vm.prank(hirer);
        escrow.registerPasskey(1, 2);
        IJobEscrow.PasskeyPubKey memory k = escrow.passkeyOf(hirer);
        assertEq(k.x, 1);
        assertEq(k.y, 2);
    }

    function test_releaseWithPasskey_revertsWithoutKey() public {
        uint256 jobId = _openJob();
        _deliver(jobId);
        vm.expectRevert(abi.encodeWithSelector(IJobEscrow.NoPasskey.selector, hirer));
        escrow.releaseWithPasskey(jobId, "", "", 1, 1);
    }

    /// @dev TODO(milestone 1): end-to-end passkey release with a real WebAuthn vector.
    ///      Needs: P256 key pair, authenticatorData, clientDataJSON containing
    ///      base64url(escrow.releaseDigest(jobId)), low-s signature. Run under `--network monad`
    ///      so the 0x0100 precompile is live.
    function test_releaseWithPasskey_validAssertion() public {
        vm.skip(true);
    }

    // ───────────── EIP-3009 ─────────────

    /// @dev TODO(milestone 1): openWithAuthorization against a fork of Monad testnet USDC
    ///      (0x534b2f3A21130d7a60830c2Df862319e593943A3) with a signed ReceiveWithAuthorization.
    function test_openWithAuthorization_fork() public {
        vm.skip(true);
    }
}

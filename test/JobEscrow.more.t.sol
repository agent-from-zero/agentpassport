// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {BaseTest} from "./Base.t.sol";
import {IJobEscrow} from "../src/interfaces/IJobEscrow.sol";
import {JobEscrow} from "../src/JobEscrow.sol";
import {P256} from "../src/libraries/P256.sol";
import {MockUSDC} from "../src/mocks/Mocks.sol";

/// @dev ERC-20 that re-enters the escrow on transfer (what a malicious settlement token could do).
contract ReentrantToken is MockUSDC {
    JobEscrow public target;
    uint256 public reenterJob;
    bool public reentered;
    bytes public lastError;

    function arm(JobEscrow t, uint256 jobId) external {
        target = t;
        reenterJob = jobId;
    }

    function transfer(address to, uint256 amount) external override returns (bool) {
        if (address(target) != address(0) && !reentered) {
            reentered = true;
            (bool ok, bytes memory err) = address(target).call(abi.encodeCall(JobEscrow.release, (reenterJob)));
            require(!ok, "reentrancy should have been blocked");
            lastError = err;
        }
        _move(msg.sender, to, amount);
        return true;
    }
}

/// @dev Passkey release, gasless (EIP-3009) open, token pinning, reentrancy, and fuzzed invariants.
contract JobEscrowSecurityTest is BaseTest {
    // ───────────── passkeys ─────────────

    uint256 internal constant HIRER_P256 = 0x7a550b7ec0de; // the hirer's passkey (test key)

    function _registerHirerPasskey() internal returns (uint256 x, uint256 y) {
        (x, y) = vm.publicKeyP256(HIRER_P256);
        vm.prank(hirer);
        escrow.registerPasskey(x, y);
    }

    function test_registerPasskey_rejectsZeroKey() public {
        vm.prank(hirer);
        vm.expectRevert(IJobEscrow.InvalidPasskey.selector);
        escrow.registerPasskey(0, 0);
    }

    /// @dev End-to-end: the hirer's passkey signs a WebAuthn assertion whose challenge is
    ///      `releaseDigest(jobId)`; anyone (here: the agent, paying gas) submits it; the P256
    ///      precompile at 0x0100 verifies it and funds + attestation flow exactly as `release`.
    function test_releaseWithPasskey_validAssertion() public {
        _registerHirerPasskey();
        uint256 jobId = _openJob();
        _deliver(jobId);

        (bytes memory authData, bytes memory cdj, uint256 r, uint256 s_) =
            _passkeyAssertion(HIRER_P256, escrow.releaseDigest(jobId));

        vm.expectEmit(true, true, true, true);
        emit IJobEscrow.JobReleased(jobId, agentId, hirer, PRICE);
        vm.prank(agentWallet);
        escrow.releaseWithPasskey(jobId, authData, cdj, r, s_);

        assertEq(usdc.balanceOf(agentWallet), PRICE);
        assertEq(uint8(escrow.getJob(jobId).status), uint8(IJobEscrow.Status.Released));
        assertEq(passport.passportOf(agentId).jobsSettled, 1);
        assertEq(reputation.count(agentId), 1);
    }

    function test_releaseWithPasskey_rejectsHighS() public {
        _registerHirerPasskey();
        uint256 jobId = _openJob();
        _deliver(jobId);
        (bytes memory authData, bytes memory cdj, uint256 r, uint256 s_) =
            _passkeyAssertion(HIRER_P256, escrow.releaseDigest(jobId));
        vm.expectRevert(IJobEscrow.InvalidPasskeySignature.selector);
        escrow.releaseWithPasskey(jobId, authData, cdj, r, P256.N - s_);
    }

    /// @dev The challenge binds chain + escrow + jobId + agentId + deliverableHash, so an assertion
    ///      for job 1 cannot release job 2, and it cannot be submitted twice.
    function test_releaseWithPasskey_rejectsReplayOnOtherJob() public {
        _registerHirerPasskey();
        uint256 job1 = _openJob();
        uint256 job2 = _openJob();
        _deliver(job1);
        _deliver(job2);
        (bytes memory authData, bytes memory cdj, uint256 r, uint256 s_) =
            _passkeyAssertion(HIRER_P256, escrow.releaseDigest(job1));
        vm.expectRevert(IJobEscrow.InvalidPasskeySignature.selector);
        escrow.releaseWithPasskey(job2, authData, cdj, r, s_);
        escrow.releaseWithPasskey(job1, authData, cdj, r, s_);
        vm.expectRevert(abi.encodeWithSelector(IJobEscrow.InvalidStatus.selector, job1, IJobEscrow.Status.Released));
        escrow.releaseWithPasskey(job1, authData, cdj, r, s_);
    }

    function test_releaseWithPasskey_rejectsOtherHirersKey() public {
        // stranger registers a key, but the job belongs to `hirer` who has none
        (uint256 x, uint256 y) = vm.publicKeyP256(0xBAD);
        vm.prank(stranger);
        escrow.registerPasskey(x, y);
        uint256 jobId = _openJob();
        _deliver(jobId);
        (bytes memory authData, bytes memory cdj, uint256 r, uint256 s_) =
            _passkeyAssertion(0xBAD, escrow.releaseDigest(jobId));
        vm.expectRevert(abi.encodeWithSelector(IJobEscrow.NoPasskey.selector, hirer));
        escrow.releaseWithPasskey(jobId, authData, cdj, r, s_);
    }

    // ───────────── EIP-3009 (mock token; the real-USDC version is in Fork.t.sol) ─────────────

    uint256 internal constant GASLESS_HIRER_KEY = 0x6a51e55;

    function _gaslessAuth(uint128 amount, uint256 validAfter, uint256 validBefore, bytes32 nonce)
        internal
        view
        returns (IJobEscrow.Authorization memory auth)
    {
        bytes memory sig = _signReceiveAuth(
            address(usdc), GASLESS_HIRER_KEY, address(escrow), amount, validAfter, validBefore, nonce
        );
        auth = IJobEscrow.Authorization({
            from: vm.addr(GASLESS_HIRER_KEY),
            validAfter: validAfter,
            validBefore: validBefore,
            nonce: nonce,
            signature: sig
        });
    }

    function _gaslessOpen(IJobEscrow.OpenParams memory p, uint256 validAfter, uint256 validBefore, bytes32 nonce)
        internal
        returns (uint256 jobId)
    {
        IJobEscrow.Authorization memory auth = _gaslessAuth(p.amount, validAfter, validBefore, nonce);
        vm.prank(agentWallet); // the agent relays; the hirer holds no MON
        jobId = escrow.openWithAuthorization(p, auth);
    }

    function test_openWithAuthorization_fundsFromSignatureOnly() public {
        address from = vm.addr(GASLESS_HIRER_KEY);
        usdc.mint(from, PRICE);
        IJobEscrow.OpenParams memory p = _params();
        uint256 validBefore = block.timestamp + 1 hours;
        bytes32 nonce = escrow.openNonce(p, 0, validBefore);

        uint256 jobId = _gaslessOpen(p, 0, validBefore, nonce);

        assertEq(usdc.balanceOf(from), 0);
        assertEq(usdc.balanceOf(address(escrow)), PRICE);
        assertEq(escrow.getJob(jobId).hirer, from, "hirer is the signer, not the relayer");
        assertTrue(usdc.authorizationState(from, nonce));
    }

    /// @dev A relayer holding the hirer's signature must not be able to point it at another job.
    function test_openWithAuthorization_rejectsParamsNotBoundToNonce() public {
        address from = vm.addr(GASLESS_HIRER_KEY);
        usdc.mint(from, PRICE);
        IJobEscrow.OpenParams memory signedFor = _params();
        uint256 validBefore = block.timestamp + 1 hours;
        bytes32 nonce = escrow.openNonce(signedFor, 0, validBefore);

        IJobEscrow.OpenParams memory tampered = signedFor;
        tampered.specHash = keccak256("a different job");
        bytes32 expected = escrow.openNonce(tampered, 0, validBefore);
        IJobEscrow.Authorization memory auth = _gaslessAuth(tampered.amount, 0, validBefore, nonce);
        vm.prank(agentWallet);
        vm.expectRevert(abi.encodeWithSelector(IJobEscrow.AuthorizationMismatch.selector, expected, nonce));
        escrow.openWithAuthorization(tampered, auth);
    }

    function test_openWithAuthorization_rejectsReplay() public {
        address from = vm.addr(GASLESS_HIRER_KEY);
        usdc.mint(from, 2 * PRICE);
        IJobEscrow.OpenParams memory p = _params();
        uint256 validBefore = block.timestamp + 1 hours;
        bytes32 nonce = escrow.openNonce(p, 0, validBefore);
        _gaslessOpen(p, 0, validBefore, nonce);
        IJobEscrow.Authorization memory auth = _gaslessAuth(p.amount, 0, validBefore, nonce);
        vm.prank(agentWallet);
        vm.expectRevert(bytes("FiatTokenV2: authorization is used or canceled"));
        escrow.openWithAuthorization(p, auth);
    }

    function testFuzz_openNonce_isInjectiveInParams(bytes32 specA, bytes32 specB, uint128 amtA, uint128 amtB)
        public
        view
    {
        vm.assume(specA != specB || amtA != amtB);
        IJobEscrow.OpenParams memory a = _params();
        IJobEscrow.OpenParams memory b = _params();
        a.specHash = specA;
        b.specHash = specB;
        a.amount = amtA;
        b.amount = amtB;
        assertTrue(escrow.openNonce(a, 0, 1) != escrow.openNonce(b, 0, 1));
        assertTrue(escrow.openNonce(a, 0, 1) != escrow.openNonce(a, 0, 2), "validity window is part of the nonce");
    }

    // ───────────── token pinning / reentrancy ─────────────

    function test_open_revertsOnUnsupportedToken() public {
        MockUSDC other = new MockUSDC();
        other.mint(hirer, PRICE);
        IJobEscrow.OpenParams memory p = _params();
        p.token = address(other);
        vm.startPrank(hirer);
        other.approve(address(escrow), PRICE);
        vm.expectRevert(abi.encodeWithSelector(IJobEscrow.UnsupportedToken.selector, address(other)));
        escrow.open(p);
        vm.stopPrank();
        assertEq(escrow.settlementToken(), address(usdc));
    }

    function test_constructor_rejectsZeroToken() public {
        vm.expectRevert(abi.encodeWithSelector(IJobEscrow.UnsupportedToken.selector, address(0)));
        new JobEscrow(address(identity), address(passport), address(0));
    }

    function test_release_blocksReentrancy() public {
        ReentrantToken evil = new ReentrantToken();
        JobEscrow escrow2 = new JobEscrow(address(identity), address(passport), address(evil));
        passport.setAttester(address(escrow2), true);
        evil.mint(hirer, PRICE);
        IJobEscrow.OpenParams memory p = _params();
        p.token = address(evil);
        vm.startPrank(hirer);
        evil.approve(address(escrow2), PRICE);
        uint256 jobId = escrow2.open(p);
        vm.stopPrank();
        vm.prank(agentWallet);
        escrow2.deliver(jobId, keccak256("d"), "");
        evil.arm(escrow2, jobId);

        // agentId has no attestations yet in this test, so escrow2's token becomes its first token.
        vm.prank(hirer);
        escrow2.release(jobId);
        assertTrue(evil.reentered(), "token attempted re-entry");
        // The mutex fires first (we are inside a nonReentrant call when the token calls back).
        assertEq(evil.lastError(), abi.encodeWithSelector(JobEscrow.Reentrancy.selector));
        assertEq(evil.balanceOf(agentWallet), PRICE, "paid exactly once");
    }

    // ───────────── fuzzed invariants ─────────────

    function testFuzz_openDeliverRelease_conservesBalances(uint128 amount, uint64 reviewWindow, uint64 ttl) public {
        amount = uint128(bound(amount, 1, 1_000_000_000));
        ttl = uint64(bound(ttl, 1, 365 days));
        IJobEscrow.OpenParams memory p = _params();
        p.amount = amount;
        p.deadline = uint64(block.timestamp) + ttl;
        p.reviewWindow = reviewWindow;
        uint256 hirerBefore = usdc.balanceOf(hirer);

        vm.prank(hirer);
        uint256 jobId = escrow.open(p);
        assertEq(usdc.balanceOf(address(escrow)), amount);
        _deliver(jobId);
        vm.prank(hirer);
        escrow.release(jobId);

        assertEq(usdc.balanceOf(address(escrow)), 0);
        assertEq(usdc.balanceOf(agentWallet), amount);
        assertEq(usdc.balanceOf(hirer), hirerBefore - amount);
        assertEq(passport.passportOf(agentId).volumeSettled, amount);
    }

    function testFuzz_release_byAnyoneOnlyAfterWindow(uint64 reviewWindow, uint64 elapsed) public {
        reviewWindow = uint64(bound(reviewWindow, 0, 30 days));
        elapsed = uint64(bound(elapsed, 0, 60 days));
        IJobEscrow.OpenParams memory p = _params();
        p.reviewWindow = reviewWindow;
        p.deadline = uint64(block.timestamp + 90 days);
        vm.prank(hirer);
        uint256 jobId = escrow.open(p);
        _deliver(jobId);
        vm.warp(block.timestamp + elapsed);
        vm.prank(stranger);
        if (elapsed > reviewWindow) {
            escrow.release(jobId);
            assertEq(usdc.balanceOf(agentWallet), PRICE);
        } else {
            vm.expectRevert(abi.encodeWithSelector(IJobEscrow.NotAuthorizedToRelease.selector, jobId, stranger));
            escrow.release(jobId);
        }
    }

    function testFuzz_refund_onlyAfterDeadline(uint64 ttl, uint64 elapsed) public {
        ttl = uint64(bound(ttl, 1, 365 days));
        elapsed = uint64(bound(elapsed, 0, 2 * 365 days));
        IJobEscrow.OpenParams memory p = _params();
        p.deadline = uint64(block.timestamp) + ttl;
        vm.prank(hirer);
        uint256 jobId = escrow.open(p);
        vm.warp(block.timestamp + elapsed);
        vm.prank(hirer);
        if (elapsed > ttl) {
            escrow.refund(jobId);
            assertEq(usdc.balanceOf(address(escrow)), 0);
        } else {
            vm.expectRevert(abi.encodeWithSelector(IJobEscrow.DeadlineNotPassed.selector, jobId, p.deadline));
            escrow.refund(jobId);
        }
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IJobEscrow} from "./interfaces/IJobEscrow.sol";
import {IAgentPassport} from "./interfaces/IAgentPassport.sol";
import {IIdentityRegistry} from "./interfaces/IERC8004.sol";
import {IERC20, IERC3009} from "./interfaces/IERC20.sol";
import {WebAuthn} from "./libraries/WebAuthn.sol";

/// @title JobEscrow — USDC escrow for hiring ERC-8004 agents, attesting outcomes to AgentPassport
/// @notice See `IJobEscrow` for the lifecycle. This contract holds funds; keep it small and boring.
/// @dev Reentrancy: state is finalised before any token transfer (checks-effects-interactions) and
///      a simple mutex guards the transfer paths. Exactly one settlement token is accepted (set at
///      deployment, Circle USDC on Monad): it is well-behaved, and pinning it means no third party
///      can bind an agent's passport to a token of their choosing.
contract JobEscrow is IJobEscrow {
    /// @dev Domain tag for `openNonce`: keccak256("AgentPassport.JobEscrow.openWithAuthorization").
    bytes32 internal constant OPEN_AUTH_TYPEHASH = keccak256("AgentPassport.JobEscrow.openWithAuthorization");

    IIdentityRegistry internal immutable _identity;
    IAgentPassport internal immutable _passport;
    address internal immutable _token;

    uint256 internal _jobCount;
    mapping(uint256 => Job) internal _jobs;
    mapping(uint256 => string) internal _endpoints; // jobId => endpoint label (forwarded to feedback)
    mapping(address => PasskeyPubKey) internal _passkeys; // hirer => registered P256 key

    uint256 internal _lock = 1;

    error Reentrancy();
    error TransferFailed();

    modifier nonReentrant() {
        if (_lock != 1) revert Reentrancy();
        _lock = 2;
        _;
        _lock = 1;
    }

    /// @param identityRegistry_ ERC-8004 IdentityRegistry.
    /// @param passport_         AgentPassport that has (or will) allow this contract as attester.
    /// @param token_            The only settlement token accepted (Circle USDC on Monad).
    constructor(address identityRegistry_, address passport_, address token_) {
        if (token_ == address(0)) revert UnsupportedToken(token_);
        _identity = IIdentityRegistry(identityRegistry_);
        _passport = IAgentPassport(passport_);
        _token = token_;
    }

    // ───────────────────────────── open ─────────────────────────────

    /// @inheritdoc IJobEscrow
    function open(OpenParams calldata p) external nonReentrant returns (uint256 jobId) {
        jobId = _create(p, msg.sender);
        if (!IERC20(p.token).transferFrom(msg.sender, address(this), p.amount)) revert TransferFailed();
    }

    /// @inheritdoc IJobEscrow
    function openWithAuthorization(OpenParams calldata p, Authorization calldata auth)
        external
        nonReentrant
        returns (uint256 jobId)
    {
        bytes32 expected = openNonce(p, auth.validAfter, auth.validBefore);
        if (auth.nonce != expected) revert AuthorizationMismatch(expected, auth.nonce);
        jobId = _create(p, auth.from);
        // EIP-3009: the token verifies the hirer's signature and moves funds to msg.sender == this.
        // The nonce check above is what ties that signature to *this* job (see IJobEscrow).
        IERC3009(p.token)
            .receiveWithAuthorization(
                auth.from, address(this), p.amount, auth.validAfter, auth.validBefore, auth.nonce, auth.signature
            );
    }

    /// @inheritdoc IJobEscrow
    function openNonce(OpenParams calldata p, uint256 validAfter, uint256 validBefore) public view returns (bytes32) {
        return keccak256(
            abi.encode(
                OPEN_AUTH_TYPEHASH,
                block.chainid,
                address(this),
                p.agentId,
                p.token,
                p.amount,
                p.deadline,
                p.reviewWindow,
                p.verifier,
                p.specHash,
                keccak256(bytes(p.endpoint)),
                validAfter,
                validBefore
            )
        );
    }

    function _create(OpenParams calldata p, address hirer) internal returns (uint256 jobId) {
        if (p.token != _token) revert UnsupportedToken(p.token);
        if (p.amount == 0) revert ZeroAmount();
        if (p.deadline <= block.timestamp) revert BadDeadline();
        // Reverts (ERC721NonexistentToken) if the agent does not exist.
        try _identity.ownerOf(p.agentId) returns (address) {}
        catch {
            revert UnknownAgent(p.agentId);
        }

        jobId = ++_jobCount;
        Job storage j = _jobs[jobId];
        j.agentId = p.agentId;
        j.hirer = hirer;
        j.verifier = p.verifier;
        j.token = p.token;
        j.amount = p.amount;
        j.deadline = p.deadline;
        j.reviewWindow = p.reviewWindow;
        j.status = Status.Open;
        j.specHash = p.specHash;
        _endpoints[jobId] = p.endpoint;

        emit JobOpened(jobId, p.agentId, hirer, p.token, p.amount, p.deadline, p.specHash, p.endpoint);
    }

    // ───────────────────────────── deliver ─────────────────────────────

    /// @inheritdoc IJobEscrow
    function deliver(uint256 jobId, bytes32 deliverableHash, string calldata deliverableURI) external {
        Job storage j = _jobs[jobId];
        if (j.status != Status.Open) revert InvalidStatus(jobId, j.status);
        if (!_isAgent(j.agentId, msg.sender)) revert NotAgent(jobId, msg.sender);

        j.status = Status.Delivered;
        j.deliveredAt = uint64(block.timestamp);
        j.deliverableHash = deliverableHash;
        emit JobDelivered(jobId, j.agentId, deliverableHash, deliverableURI);
    }

    /// @dev Owner, approved operator, or the registered agentWallet may act for the agent.
    function _isAgent(uint256 agentId, address who) internal view returns (bool) {
        if (_identity.isAuthorizedOrOwner(who, agentId)) return true;
        return _identity.getAgentWallet(agentId) == who;
    }

    // ───────────────────────────── release ─────────────────────────────

    /// @inheritdoc IJobEscrow
    function release(uint256 jobId) external nonReentrant {
        Job storage j = _jobs[jobId];
        if (j.status != Status.Delivered) revert InvalidStatus(jobId, j.status);
        bool privileged = msg.sender == j.hirer || (j.verifier != address(0) && msg.sender == j.verifier);
        bool windowElapsed = block.timestamp > uint256(j.deliveredAt) + j.reviewWindow;
        if (!privileged && !windowElapsed) revert NotAuthorizedToRelease(jobId, msg.sender);
        _release(jobId, j, msg.sender);
    }

    /// @inheritdoc IJobEscrow
    function releaseWithPasskey(
        uint256 jobId,
        bytes calldata authenticatorData,
        bytes calldata clientDataJSON,
        uint256 r,
        uint256 s
    ) external nonReentrant {
        Job storage j = _jobs[jobId];
        if (j.status != Status.Delivered) revert InvalidStatus(jobId, j.status);
        PasskeyPubKey memory k = _passkeys[j.hirer];
        if (k.x == 0 && k.y == 0) revert NoPasskey(j.hirer);
        WebAuthn.Assertion memory a =
            WebAuthn.Assertion({authenticatorData: authenticatorData, clientDataJSON: clientDataJSON, r: r, s: s});
        if (!WebAuthn.verify(releaseDigest(jobId), true, a, k.x, k.y)) revert InvalidPasskeySignature();
        _release(jobId, j, j.hirer);
    }

    function _release(uint256 jobId, Job storage j, address releasedBy) internal {
        address payTo = _identity.getAgentWallet(j.agentId);
        if (payTo == address(0)) payTo = _identity.ownerOf(j.agentId);
        if (payTo == address(0)) revert NoAgentWallet(j.agentId);

        j.status = Status.Released;
        uint256 amount = j.amount;
        emit JobReleased(jobId, j.agentId, releasedBy, amount);

        _passport.attest(
            j.agentId, _jobRef(jobId), IAgentPassport.Outcome.Settled, j.token, amount, j.hirer, _endpoints[jobId]
        );
        if (!IERC20(j.token).transfer(payTo, amount)) revert TransferFailed();
    }

    // ───────────────────────────── refund / dispute ─────────────────────────────

    /// @inheritdoc IJobEscrow
    function refund(uint256 jobId) external nonReentrant {
        Job storage j = _jobs[jobId];
        if (j.status != Status.Open) revert InvalidStatus(jobId, j.status);
        if (msg.sender != j.hirer) revert NotHirer(jobId, msg.sender);
        if (block.timestamp <= j.deadline) revert DeadlineNotPassed(jobId, j.deadline);

        j.status = Status.Refunded;
        uint256 amount = j.amount;
        emit JobRefunded(jobId, j.agentId, amount);
        _passport.attest(
            j.agentId, _jobRef(jobId), IAgentPassport.Outcome.Refunded, j.token, 0, j.hirer, _endpoints[jobId]
        );
        if (!IERC20(j.token).transfer(j.hirer, amount)) revert TransferFailed();
    }

    /// @inheritdoc IJobEscrow
    function dispute(uint256 jobId) external nonReentrant {
        Job storage j = _jobs[jobId];
        if (j.status != Status.Delivered) revert InvalidStatus(jobId, j.status);
        if (msg.sender != j.hirer) revert NotHirer(jobId, msg.sender);
        uint64 until = j.deliveredAt + j.reviewWindow;
        if (block.timestamp > until) revert ReviewWindowClosed(jobId, until);

        // v0: dispute == refund + negative attestation. v1: route to a resolver (TODO milestone 2).
        j.status = Status.Disputed;
        uint256 amount = j.amount;
        emit JobDisputed(jobId, j.agentId, msg.sender);
        _passport.attest(
            j.agentId, _jobRef(jobId), IAgentPassport.Outcome.Disputed, j.token, 0, j.hirer, _endpoints[jobId]
        );
        if (!IERC20(j.token).transfer(j.hirer, amount)) revert TransferFailed();
    }

    // ───────────────────────────── passkeys ─────────────────────────────

    /// @inheritdoc IJobEscrow
    /// @dev Only the trivial (0,0) key is rejected here; the P256 precompile rejects points that
    ///      are not on the curve at verification time, so a garbage key can never release funds.
    function registerPasskey(uint256 x, uint256 y) external {
        if (x == 0 && y == 0) revert InvalidPasskey();
        _passkeys[msg.sender] = PasskeyPubKey({x: x, y: y});
        emit PasskeyRegistered(msg.sender, x, y);
    }

    /// @inheritdoc IJobEscrow
    function releaseDigest(uint256 jobId) public view returns (bytes32) {
        Job storage j = _jobs[jobId];
        return keccak256(
            abi.encode("AgentPassport.release", block.chainid, address(this), jobId, j.agentId, j.deliverableHash)
        );
    }

    // ───────────────────────────── views ─────────────────────────────

    function getJob(uint256 jobId) external view returns (Job memory) {
        return _jobs[jobId];
    }

    function jobCount() external view returns (uint256) {
        return _jobCount;
    }

    function passport() external view returns (address) {
        return address(_passport);
    }

    function identityRegistry() external view returns (address) {
        return address(_identity);
    }

    function settlementToken() external view returns (address) {
        return _token;
    }

    function passkeyOf(address hirer) external view returns (PasskeyPubKey memory) {
        return _passkeys[hirer];
    }

    function _jobRef(uint256 jobId) internal view returns (bytes32) {
        return keccak256(abi.encode(address(this), jobId));
    }
}

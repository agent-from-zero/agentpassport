// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IJobEscrow — hire an ERC-8004 agent with USDC held in escrow
/// @notice Lifecycle: Open -> Delivered -> Released (paid) | Refunded (timeout) | Disputed.
///         An Open job is *unaccepted* until the agent calls `accept` (or `deliver`, which implies
///         acceptance). Released and Disputed are always attested into `IAgentPassport`; Refunded is
///         attested only for an accepted job ("the agent committed and did not deliver"), so nobody
///         can put a mark on an agent's passport by opening a job the agent never took.
/// @dev Release authorisation paths (any one suffices):
///        1. the hirer (EOA or smart wallet) calls `release`;
///        2. the hirer's registered passkey signs a WebAuthn assertion over `releaseDigest(jobId)`,
///           verified on-chain through Monad's P256 precompile (`releaseWithPasskey`);
///        3. an optional per-job `verifier` address (an oracle, a CRE workflow, another agent)
///           calls `release` after checking the deliverable off-chain;
///        4. anyone, once the post-delivery review window has elapsed without a dispute
///           (protects the agent from hirers who go silent).
interface IJobEscrow {
    enum Status {
        None,
        Open,
        Delivered,
        Released,
        Refunded,
        Disputed
    }

    struct Job {
        uint256 agentId; // ERC-8004 agent being hired
        address hirer; // funder; receives refunds
        address verifier; // optional third party allowed to release (address(0) = none)
        address token; // settlement token (USDC)
        uint128 amount; // escrowed amount
        uint64 deadline; // after this, hirer may refund if not delivered
        uint64 reviewWindow; // seconds after delivery during which hirer may dispute
        uint64 deliveredAt; // 0 until delivered
        Status status;
        bytes32 specHash; // keccak256 of the job spec (off-chain document)
        bytes32 deliverableHash; // keccak256 of the deliverable, set by the agent
    }

    /// @notice A P256 public key registered by a hirer for passkey-authorised releases.
    struct PasskeyPubKey {
        uint256 x;
        uint256 y;
    }

    event JobOpened(
        uint256 indexed jobId,
        uint256 indexed agentId,
        address indexed hirer,
        address token,
        uint256 amount,
        uint64 deadline,
        bytes32 specHash,
        string endpoint
    );
    event JobAccepted(uint256 indexed jobId, uint256 indexed agentId, address indexed by);
    event JobDelivered(uint256 indexed jobId, uint256 indexed agentId, bytes32 deliverableHash, string deliverableURI);
    event JobReleased(uint256 indexed jobId, uint256 indexed agentId, address indexed releasedBy, uint256 amount);
    event JobRefunded(uint256 indexed jobId, uint256 indexed agentId, uint256 amount);
    event JobDisputed(uint256 indexed jobId, uint256 indexed agentId, address indexed by);
    event PasskeyRegistered(address indexed hirer, uint256 x, uint256 y);

    error InvalidStatus(uint256 jobId, Status current);
    error NotHirer(uint256 jobId, address caller);
    error NotAgent(uint256 jobId, address caller);
    error NotAuthorizedToRelease(uint256 jobId, address caller);
    error DeadlineNotPassed(uint256 jobId, uint64 deadline);
    error ReviewWindowClosed(uint256 jobId, uint64 until);
    error ZeroAmount();
    error BadDeadline();
    error NoPasskey(address hirer);
    error InvalidPasskeySignature();
    error UnknownAgent(uint256 agentId);
    error NoAgentWallet(uint256 agentId);
    error UnsupportedToken(address token);
    error AuthorizationMismatch(bytes32 expectedNonce, bytes32 givenNonce);
    error InvalidPasskey();
    error DeadlinePassed(uint256 jobId, uint64 deadline);
    error AlreadyAccepted(uint256 jobId);
    error BadReviewWindow(uint64 reviewWindow, uint64 max);
    error EndpointTooLong(uint256 length);

    /// @notice Parameters for opening a job.
    /// @param agentId  Agent to hire (must exist in the ERC-8004 IdentityRegistry).
    /// @param token    Settlement token; must equal `settlementToken()` (Circle USDC on Monad testnet:
    ///                 0x534b2f3A21130d7a60830c2Df862319e593943A3). Pinning one token stops a griefer from
    ///                 binding an agent's passport to a junk token via an expired job.
    /// @param amount   Escrowed amount in token units.
    /// @param deadline Unix time after which the hirer can refund an undelivered job.
    /// @param reviewWindow Seconds after delivery in which the hirer may dispute; after it passes,
    ///                 anyone may finalise the release. At most `MAX_REVIEW_WINDOW` (30 days). A window
    ///                 of 0 lets the agent finalise from the next second on: only sensible with a
    ///                 `verifier`, or when the hirer releases in the same flow.
    /// @param verifier Optional address allowed to release on the hirer's behalf.
    /// @param specHash keccak256 of the job specification.
    /// @param endpoint Free-form label of the skill/endpoint being hired (forwarded to feedback),
    ///                 at most `MAX_ENDPOINT_LENGTH` (256) bytes.
    struct OpenParams {
        uint256 agentId;
        address token;
        uint128 amount;
        uint64 deadline;
        uint64 reviewWindow;
        address verifier;
        bytes32 specHash;
        string endpoint;
    }

    /// @notice An EIP-3009 `receiveWithAuthorization` signed by the hirer (same signature type
    ///         x402's "exact" EVM scheme uses). `to` is implicitly the escrow contract.
    /// @dev `nonce` MUST equal `openNonce(p, validAfter, validBefore)`: the nonce is the only
    ///      free field in the EIP-3009 message, so binding it to the job parameters is what stops
    ///      a relayer from spending the hirer's signature on a different agent, amount or spec.
    struct Authorization {
        address from;
        uint256 validAfter;
        uint256 validBefore;
        bytes32 nonce;
        bytes signature;
    }

    /// @notice Opens a job and pulls `p.amount` of `p.token` from `msg.sender` (needs prior approval).
    function open(OpenParams calldata p) external returns (uint256 jobId);

    /// @notice Same as `open`, funded by an EIP-3009 authorization signed by `auth.from` (the hirer).
    ///         The caller (relayer / the agent itself) pays gas; the hirer needs no MON.
    ///         Reverts with `AuthorizationMismatch` unless `auth.nonce == openNonce(p, ...)`.
    function openWithAuthorization(OpenParams calldata p, Authorization calldata auth) external returns (uint256 jobId);

    /// @notice The EIP-3009 nonce a hirer must sign with so that the authorization can only fund
    ///         exactly this job (chain, escrow, all OpenParams, validity window).
    function openNonce(OpenParams calldata p, uint256 validAfter, uint256 validBefore) external view returns (bytes32);

    /// @notice Agent (owner, operator or agentWallet of `agentId`) commits to an Open job before its
    ///         deadline. From then on the hirer can refund only after the deadline, and that refund
    ///         is recorded on the agent's passport. Optional: `deliver` implies acceptance.
    function accept(uint256 jobId) external;

    /// @notice Agent (owner, operator or agentWallet of `agentId`) submits the deliverable hash.
    ///         Only while the job is Open and not past its deadline, so a late delivery cannot
    ///         front-run the hirer's refund. Marks the job accepted if it was not already.
    function deliver(uint256 jobId, bytes32 deliverableHash, string calldata deliverableURI) external;

    /// @notice Releases escrow to the agent wallet. Callable by hirer or verifier at any time
    ///         after delivery, or by anyone once the review window has elapsed.
    function release(uint256 jobId) external;

    /// @notice Releases escrow with a WebAuthn/P256 assertion from the hirer's registered passkey.
    /// @param authenticatorData Raw authenticatorData from the assertion.
    /// @param clientDataJSON    Raw clientDataJSON; must contain the base64url challenge of
    ///                          `releaseDigest(jobId)` and type "webauthn.get".
    /// @param r  Signature r.
    /// @param s  Signature s (must be low-s; the contract rejects malleable values).
    function releaseWithPasskey(
        uint256 jobId,
        bytes calldata authenticatorData,
        bytes calldata clientDataJSON,
        uint256 r,
        uint256 s
    ) external;

    /// @notice Hirer takes back the escrow of an Open (undelivered) job:
    ///         - not accepted by the agent: at any time (a cancel); the passport is not touched;
    ///         - accepted: only after the deadline; the passport records a refund against the agent.
    function refund(uint256 jobId) external;

    /// @notice Hirer disputes within the review window. v0: funds return to hirer and the
    ///         passport records a dispute; v1 routes to a resolver.
    function dispute(uint256 jobId) external;

    /// @notice Registers (or replaces) the caller's passkey public key for `releaseWithPasskey`.
    function registerPasskey(uint256 x, uint256 y) external;

    /// @notice The 32-byte challenge a passkey must sign to release `jobId` (domain-separated).
    function releaseDigest(uint256 jobId) external view returns (bytes32);

    /// @notice When the agent accepted `jobId` (0 = not accepted).
    function acceptedAt(uint256 jobId) external view returns (uint64);

    function getJob(uint256 jobId) external view returns (Job memory);
    function jobCount() external view returns (uint256);
    function passport() external view returns (address);
    function identityRegistry() external view returns (address);
    /// @notice The single settlement token this escrow accepts (Circle USDC on Monad).
    function settlementToken() external view returns (address);
    /// @notice Upper bound on `OpenParams.reviewWindow` (30 days).
    function MAX_REVIEW_WINDOW() external view returns (uint64);
    /// @notice Upper bound on `bytes(OpenParams.endpoint).length` (256).
    function MAX_ENDPOINT_LENGTH() external view returns (uint256);
    /// @notice "2": agent acceptance, delivery deadline, bounded review window and endpoint.
    function version() external pure returns (string memory);
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title IAgentPassport — the read model other applications build on
/// @notice A passport is a compact, append-only record of *settled* work for an ERC-8004 agent.
///         Entries can only be written by registered attesters (e.g. `JobEscrow`), i.e. only when
///         money actually moved on verified delivery. Consumers read `passportOf` or ask
///         `meets(agentId, policy)` before trusting/hiring/routing to an agent.
/// @dev Storage is laid out so one agent's record fits a single Monad storage page (MIP-8): the
///      first touch pays the cold cost, the rest of the struct is warm.
interface IAgentPassport {
    /// @notice Per-agent settled-work summary. Volumes are in the token's smallest unit.
    struct Passport {
        uint64 jobsSettled; // jobs where funds were released to the agent
        uint64 jobsRefunded; // jobs that expired/refunded without delivery
        uint64 jobsDisputed; // jobs closed by dispute resolution against the agent
        uint64 firstSeen; // block.timestamp of first attested job
        uint64 lastSettled; // block.timestamp of last settlement
        uint128 volumeSettled; // sum of released amounts (single settlement token per passport)
        address token; // settlement token (e.g. USDC); address(0) until first attestation
    }

    /// @notice A hiring policy a consumer can evaluate on-chain in one call.
    struct Policy {
        uint64 minJobsSettled;
        uint128 minVolumeSettled;
        uint64 maxJobsDisputed;
        uint64 maxAgeOfLastSettlement; // seconds; 0 = ignore
    }

    /// @dev Outcome of a job as reported by an attester.
    enum Outcome {
        Settled,
        Refunded,
        Disputed
    }

    event AttesterSet(address indexed attester, bool allowed);
    event Attested(
        uint256 indexed agentId,
        address indexed attester,
        bytes32 indexed jobRef,
        Outcome outcome,
        address token,
        uint256 amount,
        address hirer
    );
    event FeedbackMirrored(uint256 indexed agentId, bytes32 indexed jobRef, bool ok);

    error NotAttester(address caller);
    error TokenMismatch(address expected, address given);

    /// @notice Records a job outcome for `agentId`. Callable only by allowed attesters.
    /// @param agentId  ERC-8004 agent id (must exist in the IdentityRegistry).
    /// @param jobRef   Attester-scoped reference (e.g. keccak256(escrow, jobId)) — becomes the
    ///                 ERC-8004 `feedbackHash` so anyone can link feedback to the job.
    /// @param outcome  Settled / Refunded / Disputed.
    /// @param token    Settlement token.
    /// @param amount   Amount released to the agent (0 for refunds).
    /// @param hirer    Counterparty that funded the job.
    /// @param endpoint Free-form skill/endpoint label forwarded to ERC-8004 feedback.
    function attest(
        uint256 agentId,
        bytes32 jobRef,
        Outcome outcome,
        address token,
        uint256 amount,
        address hirer,
        string calldata endpoint
    ) external;

    function passportOf(uint256 agentId) external view returns (Passport memory);

    /// @notice One-call policy check for integrators (routers, marketplaces, other agents).
    function meets(uint256 agentId, Policy calldata policy) external view returns (bool);

    /// @notice Number of settled jobs between a specific hirer and agent (repeat-business signal).
    function settledBetween(address hirer, uint256 agentId) external view returns (uint64);

    function identityRegistry() external view returns (address);
    function reputationRegistry() external view returns (address);
    function isAttester(address attester) external view returns (bool);
}

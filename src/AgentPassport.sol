// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IAgentPassport} from "./interfaces/IAgentPassport.sol";
import {IIdentityRegistry, IReputationRegistry} from "./interfaces/IERC8004.sol";

/// @title AgentPassport — escrow-backed reputation record for ERC-8004 agents
/// @notice Append-only per-agent summary of settled work, written only by allowed attesters
///         (e.g. `JobEscrow`) and mirrored into the canonical ERC-8004 ReputationRegistry.
/// @dev Feedback mirroring is best-effort: a revert in the registry (e.g. the agent's owner is
///      somehow this contract, or the registry is upgraded) must never block a settlement, so the
///      call is made low-level and only its success flag is emitted.
contract AgentPassport is IAgentPassport {
    /// @dev Score written to ERC-8004 for a settled job: 1.00 (value=100, decimals=2).
    int128 internal constant SETTLED_VALUE = 100;
    /// @dev Score for a dispute closed against the agent: 0.00.
    int128 internal constant DISPUTED_VALUE = 0;
    uint8 internal constant VALUE_DECIMALS = 2;
    string internal constant TAG1 = "agentpassport";

    IIdentityRegistry internal immutable _identity;
    IReputationRegistry internal immutable _reputation;
    address public owner;

    mapping(address => bool) internal _attesters;
    mapping(uint256 => Passport) internal _passports;
    mapping(address => mapping(uint256 => uint64)) internal _settledBetween;

    error NotOwner();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyAttester() {
        if (!_attesters[msg.sender]) revert NotAttester(msg.sender);
        _;
    }

    /// @param identityRegistry_   ERC-8004 IdentityRegistry (Monad testnet: 0x8004A818BFB912233c491871b3d84c89A494BD9e)
    /// @param reputationRegistry_ ERC-8004 ReputationRegistry (Monad testnet: 0x8004B663056A597Dffe9eCcC1965A193B7388713)
    constructor(address identityRegistry_, address reputationRegistry_) {
        _identity = IIdentityRegistry(identityRegistry_);
        _reputation = IReputationRegistry(reputationRegistry_);
        owner = msg.sender;
    }

    // ───────────────────────────── admin ─────────────────────────────

    /// @notice Allow or disallow an attester (an escrow module). Owner-only; owner is meant to be
    ///         renounced to a multisig/timelock or address(0) once the attester set is final.
    function setAttester(address attester, bool allowed) external onlyOwner {
        _attesters[attester] = allowed;
        emit AttesterSet(attester, allowed);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        owner = newOwner;
    }

    // ───────────────────────────── write ─────────────────────────────

    /// @inheritdoc IAgentPassport
    function attest(
        uint256 agentId,
        bytes32 jobRef,
        Outcome outcome,
        address token,
        uint256 amount,
        address hirer,
        string calldata endpoint
    ) external onlyAttester {
        Passport storage p = _passports[agentId];
        if (p.firstSeen == 0) {
            p.firstSeen = uint64(block.timestamp);
            p.token = token;
        } else if (p.token != token) {
            revert TokenMismatch(p.token, token);
        }

        if (outcome == Outcome.Settled) {
            p.jobsSettled += 1;
            p.lastSettled = uint64(block.timestamp);
            p.volumeSettled += uint128(amount);
            _settledBetween[hirer][agentId] += 1;
        } else if (outcome == Outcome.Refunded) {
            p.jobsRefunded += 1;
        } else {
            p.jobsDisputed += 1;
        }

        emit Attested(agentId, msg.sender, jobRef, outcome, token, amount, hirer);

        // Mirror to ERC-8004 for Settled / Disputed (refunds carry no signal about the agent's
        // work quality beyond "did not deliver", which the passport itself records).
        if (outcome != Outcome.Refunded) {
            _mirrorFeedback(agentId, jobRef, outcome, endpoint);
        }
    }

    function _mirrorFeedback(uint256 agentId, bytes32 jobRef, Outcome outcome, string calldata endpoint) internal {
        int128 value = outcome == Outcome.Settled ? SETTLED_VALUE : DISPUTED_VALUE;
        string memory tag2 = outcome == Outcome.Settled ? "settled" : "disputed";
        // Low-level call (not try/catch): a high-level call to an address without code reverts
        // before the call and would not be caught. Settlement must never depend on the registry.
        (bool ok,) = address(_reputation)
            .call(
                abi.encodeCall(
                    IReputationRegistry.giveFeedback, (agentId, value, VALUE_DECIMALS, TAG1, tag2, endpoint, "", jobRef)
                )
            );
        // A call to an address without code "succeeds"; report that honestly as not mirrored.
        ok = ok && address(_reputation).code.length > 0;
        emit FeedbackMirrored(agentId, jobRef, ok);
    }

    // ───────────────────────────── read ─────────────────────────────

    /// @inheritdoc IAgentPassport
    function passportOf(uint256 agentId) external view returns (Passport memory) {
        return _passports[agentId];
    }

    /// @inheritdoc IAgentPassport
    function meets(uint256 agentId, Policy calldata policy) external view returns (bool) {
        Passport storage p = _passports[agentId];
        if (p.jobsSettled < policy.minJobsSettled) return false;
        if (p.volumeSettled < policy.minVolumeSettled) return false;
        if (p.jobsDisputed > policy.maxJobsDisputed) return false;
        if (policy.maxAgeOfLastSettlement != 0) {
            if (p.lastSettled == 0) return false;
            if (block.timestamp - p.lastSettled > policy.maxAgeOfLastSettlement) return false;
        }
        return true;
    }

    /// @inheritdoc IAgentPassport
    function settledBetween(address hirer, uint256 agentId) external view returns (uint64) {
        return _settledBetween[hirer][agentId];
    }

    function identityRegistry() external view returns (address) {
        return address(_identity);
    }

    function reputationRegistry() external view returns (address) {
        return address(_reputation);
    }

    function isAttester(address attester) external view returns (bool) {
        return _attesters[attester];
    }
}

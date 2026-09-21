// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title ERC-8004 Identity Registry (subset)
/// @notice Interface of the canonical ERC-8004 IdentityRegistry as deployed on Monad
///         (testnet 0x8004A818BFB912233c491871b3d84c89A494BD9e, mainnet 0x8004A169FB4a3325136EB29fA0ceB6D2e539a432).
///         Each agent is an ERC-721 token; the token id is the `agentId`.
///         Reference: https://github.com/erc-8004/erc-8004-contracts
interface IIdentityRegistry {
    event Registered(uint256 indexed agentId, string agentURI, address indexed owner);
    event MetadataSet(
        uint256 indexed agentId, string indexed indexedMetadataKey, string metadataKey, bytes metadataValue
    );

    struct MetadataEntry {
        string metadataKey;
        bytes metadataValue;
    }

    /// @notice Mints a new agent id to `msg.sender` with an agent-card URI.
    function register(string memory agentURI) external returns (uint256 agentId);
    function register(string memory agentURI, MetadataEntry[] memory metadata) external returns (uint256 agentId);

    /// @notice ERC-721 owner of the agent token.
    function ownerOf(uint256 agentId) external view returns (address);

    /// @notice The agent's payment wallet (metadata key "agentWallet"), or address(0) if unset.
    function getAgentWallet(uint256 agentId) external view returns (address);

    /// @notice True if `spender` is the owner or an approved operator of `agentId`.
    function isAuthorizedOrOwner(address spender, uint256 agentId) external view returns (bool);

    function getMetadata(uint256 agentId, string memory metadataKey) external view returns (bytes memory);
    function setMetadata(uint256 agentId, string memory metadataKey, bytes memory metadataValue) external;
    function setAgentURI(uint256 agentId, string calldata newURI) external;
}

/// @title ERC-8004 Reputation Registry (subset)
/// @notice Interface of the canonical ERC-8004 ReputationRegistry on Monad
///         (testnet 0x8004B663056A597Dffe9eCcC1965A193B7388713, mainnet 0x8004BAa17C55a88189AE136b182e5fdA19dE9b63).
/// @dev IMPORTANT: `giveFeedback` reverts with "Self-feedback not allowed" when `msg.sender` is the
///      agent's owner or operator. AgentPassport therefore posts feedback from the escrow/passport
///      contract address, which is never an agent owner — the feedback is attributed to the
///      protocol, and its `feedbackHash` commits to the settled job.
interface IReputationRegistry {
    event NewFeedback(
        uint256 indexed agentId,
        address indexed clientAddress,
        uint64 feedbackIndex,
        int128 value,
        uint8 valueDecimals,
        string indexed indexedTag1,
        string tag1,
        string tag2,
        string endpoint,
        string feedbackURI,
        bytes32 feedbackHash
    );

    function getIdentityRegistry() external view returns (address);

    /// @notice Appends an immutable feedback entry for `agentId` from `msg.sender`.
    /// @param value        Signed fixed-point score (e.g. 100 with valueDecimals=2 => 1.00).
    /// @param valueDecimals Decimals of `value`, <= 18.
    /// @param tag1         Primary tag (indexed in the event).
    /// @param tag2         Secondary tag.
    /// @param endpoint     Endpoint/skill the feedback relates to (free-form).
    /// @param feedbackURI  Off-chain detail (may be empty).
    /// @param feedbackHash Content hash committing to the off-chain detail / the job.
    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) external;

    function getLastIndex(uint256 agentId, address clientAddress) external view returns (uint64);

    function readFeedback(uint256 agentId, address clientAddress, uint64 feedbackIndex)
        external
        view
        returns (int128 value, uint8 valueDecimals, string memory tag1, string memory tag2, bool isRevoked);

    function getClients(uint256 agentId) external view returns (address[] memory);
}

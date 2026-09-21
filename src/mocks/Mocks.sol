// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IIdentityRegistry, IReputationRegistry} from "../interfaces/IERC8004.sol";

/// @dev Minimal mintable ERC-20 with 6 decimals, standing in for Circle USDC in local tests.
///      Not for deployment: Monad testnet has real Circle USDC (0x534b2f3A21130d7a60830c2Df862319e593943A3).
contract MockUSDC {
    string public constant name = "USDC";
    string public constant symbol = "USDC";
    uint8 public constant decimals = 6;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        require(a >= amount, "allowance");
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) internal {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}

/// @dev Minimal stand-in for the ERC-8004 IdentityRegistry: sequential ids, owner + agentWallet.
contract MockIdentityRegistry {
    uint256 public nextId;
    mapping(uint256 => address) public owners;
    mapping(uint256 => address) public wallets;
    mapping(uint256 => string) public uris;

    event Registered(uint256 indexed agentId, string agentURI, address indexed owner);

    function register(string memory agentURI) external returns (uint256 agentId) {
        agentId = ++nextId;
        owners[agentId] = msg.sender;
        uris[agentId] = agentURI;
        emit Registered(agentId, agentURI, msg.sender);
    }

    function ownerOf(uint256 agentId) external view returns (address o) {
        o = owners[agentId];
        require(o != address(0), "ERC721NonexistentToken");
    }

    function isAuthorizedOrOwner(address spender, uint256 agentId) external view returns (bool) {
        return owners[agentId] == spender;
    }

    function getAgentWallet(uint256 agentId) external view returns (address) {
        return wallets[agentId];
    }

    /// @dev Test helper (the real registry requires a signature from the new wallet).
    function setAgentWalletUnsafe(uint256 agentId, address wallet) external {
        require(owners[agentId] == msg.sender, "not owner");
        wallets[agentId] = wallet;
    }
}

/// @dev Minimal stand-in for the ERC-8004 ReputationRegistry: records feedback, blocks self-feedback.
contract MockReputationRegistry {
    struct Entry {
        address client;
        int128 value;
        uint8 valueDecimals;
        string tag1;
        string tag2;
        string endpoint;
        bytes32 feedbackHash;
    }

    MockIdentityRegistry public identity;
    mapping(uint256 => Entry[]) public entries;

    constructor(MockIdentityRegistry identity_) {
        identity = identity_;
    }

    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata,
        bytes32 feedbackHash
    ) external {
        require(!identity.isAuthorizedOrOwner(msg.sender, agentId), "Self-feedback not allowed");
        entries[agentId].push(Entry(msg.sender, value, valueDecimals, tag1, tag2, endpoint, feedbackHash));
    }

    function count(uint256 agentId) external view returns (uint256) {
        return entries[agentId].length;
    }
}

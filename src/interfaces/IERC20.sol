// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title Minimal ERC-20 interface (subset used by AgentPassport)
interface IERC20 {
    function totalSupply() external view returns (uint256);
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function decimals() external view returns (uint8);

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
}

/// @title EIP-3009 subset: transfer with authorization (implemented by Circle USDC)
/// @notice This is the same signature type x402's "exact" scheme uses, so a hirer can fund an
///         escrow with one off-chain signature and zero MON (the relayer pays gas).
interface IERC3009 {
    /// @notice Pulls `value` from `from` into `msg.sender`; requires `to == msg.sender`.
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature
    ) external;
}

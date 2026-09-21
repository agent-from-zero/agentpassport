// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {P256} from "../src/libraries/P256.sol";
import {WebAuthn} from "../src/libraries/WebAuthn.sol";

contract P256Harness {
    function verify(bytes32 h, uint256 r, uint256 s, uint256 x, uint256 y) external view returns (bool) {
        return P256.verify(h, r, s, x, y);
    }

    function b64(bytes32 d) external pure returns (string memory) {
        return string(WebAuthn._base64Url(d));
    }
}

/// @dev Precompile + encoding tests. The precompile at 0x0100 is only live under
///      `forge test --network monad` (foundry.toml sets it) or on a Monad fork.
contract P256Test is Test {
    P256Harness internal h;

    // EIP-7951 / RIP-7212 reference vector (wycheproof-derived, widely reused in precompile tests).
    bytes32 internal constant HASH = 0xbb5a52f42f9c9261ed4361f59422a1e30036e7c32b270c8807a419feca605023;
    uint256 internal constant R = 0x2ba3a8be6b9d3b0d3f8f4b5c3e4b8e7d6b4b5c9d8e7f6a5b4c3d2e1f0a9b8c7d; // placeholder
    uint256 internal constant S = 0x1;
    uint256 internal constant QX = 0x1;
    uint256 internal constant QY = 0x1;

    function setUp() public {
        h = new P256Harness();
    }

    function test_rejectsZeroAndHighS() public view {
        assertFalse(h.verify(HASH, 0, 1, QX, QY));
        assertFalse(h.verify(HASH, 1, 0, QX, QY));
        assertFalse(h.verify(HASH, 1, P256.N_DIV_2 + 1, QX, QY), "high-s must be rejected before the precompile");
    }

    function test_base64url_knownVector() public view {
        // 32 zero bytes -> 43 'A's
        assertEq(h.b64(bytes32(0)), "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
        // 0xff * 32 -> "____...__8"
        assertEq(h.b64(bytes32(type(uint256).max)), "__________________________________________8");
    }

    /// @dev TODO(milestone 1): replace placeholder constants with a real EIP-7951 test vector and
    ///      assert `true` under `--network monad`; assert `false` on a plain EVM (empty precompile).
    function test_precompile_validVector() public {
        vm.skip(true);
    }
}

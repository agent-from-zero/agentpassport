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

/// @dev Precompile + encoding tests. The precompile at 0x0100 is live because foundry.toml sets
///      `network = "monad"`; on a plain EVM every `verify` below returns false (empty precompile).
contract P256Test is Test {
    P256Harness internal h;

    // RIP-7212 / EIP-7951 reference test vector (the 160-byte input from the RIP's "Test Cases",
    // expected output 0x..01). Split into hash | r | s | qx | qy.
    bytes32 internal constant HASH = 0xb5a77e7a90aa14e0bf5f337f06f597148676424fae26e175c6e5621c34351955;
    uint256 internal constant R = 0x289f319789da424845c9eac935245fcddd805950e2f02506d09be7e411199556;
    uint256 internal constant S_HIGH = 0xd262144475b1fa46ad85250728c600c53dfd10f8b3f4adf140e27241aec3c2da;
    uint256 internal constant QX = 0x3a81046703fccf468b48b145f939efdbb96c3786db712b3113bb2488ef286cdc;
    uint256 internal constant QY = 0xef8afe82d200a5bb36b5462166e8ce77f2d831a52ef2135b2af188110beaefb1;

    function setUp() public {
        h = new P256Harness();
    }

    function test_rejectsZeroAndHighS() public view {
        assertFalse(h.verify(HASH, 0, 1, QX, QY));
        assertFalse(h.verify(HASH, 1, 0, QX, QY));
        assertFalse(h.verify(HASH, 1, P256.N_DIV_2 + 1, QX, QY), "high-s must be rejected before the precompile");
        assertFalse(h.verify(HASH, P256.N, 1, QX, QY), "r >= n");
    }

    /// @dev The reference vector as published carries a high-s signature. The raw precompile
    ///      accepts it; our wrapper must reject it and accept the normalised twin (s' = n - s).
    function test_precompile_validVector() public view {
        (bool ok, bytes memory out) = address(0x0100).staticcall(abi.encodePacked(HASH, R, S_HIGH, QX, QY));
        assertTrue(ok && out.length == 32 && abi.decode(out, (uint256)) == 1, "raw precompile accepts RIP-7212 vector");

        assertFalse(h.verify(HASH, R, S_HIGH, QX, QY), "wrapper rejects the high-s form");
        assertTrue(h.verify(HASH, R, P256.N - S_HIGH, QX, QY), "wrapper accepts the low-s form");
        assertFalse(h.verify(bytes32(uint256(HASH) ^ 1), R, P256.N - S_HIGH, QX, QY), "wrong hash");
        assertFalse(h.verify(HASH, R, P256.N - S_HIGH, QX, QY ^ 1), "wrong key");
    }

    /// @dev Round-trip through Foundry's P256 signer for arbitrary keys and digests.
    function testFuzz_precompile_signRoundTrip(uint256 pk, bytes32 digest) public view {
        pk = bound(pk, 1, P256.N - 1);
        (uint256 x, uint256 y) = vm.publicKeyP256(pk);
        (bytes32 r, bytes32 s) = vm.signP256(pk, digest);
        uint256 sLow = uint256(s) > P256.N_DIV_2 ? P256.N - uint256(s) : uint256(s);
        assertTrue(h.verify(digest, uint256(r), sLow, x, y));
        assertFalse(h.verify(bytes32(uint256(digest) ^ 1), uint256(r), sLow, x, y));
    }

    function test_base64url_knownVector() public view {
        // 32 zero bytes -> 43 'A' characters
        assertEq(h.b64(bytes32(0)), "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
        // 0xff * 32 -> "____...__8"
        assertEq(h.b64(bytes32(type(uint256).max)), "__________________________________________8");
    }

    /// @dev Differential test against Foundry's encoder (which pads; RFC 4648 section 5 without
    ///      padding is what WebAuthn puts in clientDataJSON, so we strip the single '=').
    function testFuzz_base64url_matchesReference(bytes32 d) public view {
        bytes memory rb = bytes(vm.toBase64URL(abi.encodePacked(d)));
        assertEq(rb.length, 44);
        assertEq(rb[43], "=");
        bytes memory trimmed = new bytes(43);
        for (uint256 i = 0; i < 43; i++) {
            trimmed[i] = rb[i];
        }
        assertEq(h.b64(d), string(trimmed));
    }
}

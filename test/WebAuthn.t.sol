// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {P256} from "../src/libraries/P256.sol";
import {WebAuthn} from "../src/libraries/WebAuthn.sol";

contract WebAuthnHarness {
    function verify(bytes32 challenge, bool requireUV, WebAuthn.Assertion calldata a, uint256 x, uint256 y)
        external
        view
        returns (bool)
    {
        return WebAuthn.verify(challenge, requireUV, a, x, y);
    }
}

/// @dev Real authenticator captures (Safari + Chrome passkeys, credential x/y below) and synthetic
///      assertions signed with Foundry's P256 signer. The real vectors are the ones used by
///      Solady's and Coinbase Smart Wallet's WebAuthn tests (MIT); flags byte 0x05 = UP|UV.
contract WebAuthnTest is Test {
    WebAuthnHarness internal h;

    uint256 internal constant X = 0x3f2be075ef57d6c8374ef412fe54fdd980050f70f4f3a00b5b1b32d2def7d28d;
    uint256 internal constant Y = 0x57095a365acc2590ade3583fabfe8fbd64a9ed3ec07520da00636fb21f0176c1;
    bytes32 internal constant CHALLENGE = 0xf631058a3ba1116acce12396fad0a125b5041c43f8e15723709f81aa8d5f4ccf;

    function setUp() public {
        h = new WebAuthnHarness();
    }

    function _safari() internal pure returns (WebAuthn.Assertion memory a) {
        a.authenticatorData = hex"49960de5880e8c687434170f6476605b8fe4aeb9a28632c7995cf3ba831d97630500000101";
        a.clientDataJSON = abi.encodePacked(
            '{"type":"webauthn.get","challenge":"',
            WebAuthn._base64Url(CHALLENGE),
            '","origin":"http://localhost:3005"}'
        );
        a.r = 0x60946081650523acad13c8eff94996a409b1ed60e923c90f9e366aad619adffa;
        a.s = 0x3216a237b73765d01b839e0832d73474bc7e63f4c86ef05fbbbfbeb34b35602b;
    }

    function _chrome() internal pure returns (WebAuthn.Assertion memory a) {
        a.authenticatorData = hex"49960de5880e8c687434170f6476605b8fe4aeb9a28632c7995cf3ba831d9763050000010a";
        a.clientDataJSON = abi.encodePacked(
            '{"type":"webauthn.get","challenge":"',
            WebAuthn._base64Url(CHALLENGE),
            '","origin":"http://localhost:3005","crossOrigin":false}'
        );
        a.r = 0x41c01ca5ecdfeb23ef70d6cc216fd491ac3aa3d40c480751f3618a3a9ef67b41;
        a.s = 0x6595569abf76c2777e832a9252bae14efdb77febd0fa3b919aa16f6208469e86;
    }

    function test_realVector_safari() public view {
        assertTrue(h.verify(CHALLENGE, true, _safari(), X, Y));
    }

    function test_realVector_chrome() public view {
        assertTrue(h.verify(CHALLENGE, true, _chrome(), X, Y));
    }

    function test_realVector_rejectsWrongChallenge() public view {
        assertFalse(h.verify(bytes32(uint256(CHALLENGE) ^ 1), true, _chrome(), X, Y));
    }

    function test_realVector_rejectsWrongKey() public view {
        assertFalse(h.verify(CHALLENGE, true, _chrome(), X, Y ^ 1));
    }

    function test_realVector_rejectsTamperedClientData() public view {
        WebAuthn.Assertion memory a = _chrome();
        // Any byte change to clientDataJSON changes sha256(clientDataJSON) -> signature fails.
        a.clientDataJSON[a.clientDataJSON.length - 2] = "1";
        assertFalse(h.verify(CHALLENGE, true, a, X, Y));
    }

    function test_realVector_rejectsHighS() public view {
        WebAuthn.Assertion memory a = _chrome();
        a.s = P256.N - a.s; // malleable twin; the raw curve would accept it, we must not
        assertFalse(h.verify(CHALLENGE, true, a, X, Y));
    }

    function test_rejectsCreateType() public view {
        WebAuthn.Assertion memory a = _chrome();
        a.clientDataJSON = abi.encodePacked(
            '{"type":"webauthn.create","challenge":"',
            WebAuthn._base64Url(CHALLENGE),
            '","origin":"http://localhost:3005"}'
        );
        assertFalse(h.verify(CHALLENGE, true, a, X, Y));
    }

    function test_rejectsShortAuthenticatorData() public view {
        WebAuthn.Assertion memory a = _chrome();
        a.authenticatorData = hex"49960de5880e8c687434170f6476605b8fe4aeb9a28632c7995cf3ba831d9763";
        assertFalse(h.verify(CHALLENGE, true, a, X, Y));
    }

    // ───────────── synthetic assertions (Foundry P256 signer) ─────────────

    function _assert(uint256 pk, bytes32 challenge, uint8 flags, bytes memory tail)
        internal
        pure
        returns (WebAuthn.Assertion memory a)
    {
        a.authenticatorData = abi.encodePacked(sha256("agentfromzero.netlify.app"), flags, uint32(7));
        a.clientDataJSON =
            abi.encodePacked('{"type":"webauthn.get","challenge":"', WebAuthn._base64Url(challenge), '"', tail);
        bytes32 msgHash = sha256(abi.encodePacked(a.authenticatorData, sha256(a.clientDataJSON)));
        (bytes32 r, bytes32 s) = vm.signP256(pk, msgHash);
        a.r = uint256(r);
        a.s = uint256(s) > P256.N_DIV_2 ? P256.N - uint256(s) : uint256(s);
    }

    function testFuzz_synthetic_roundTrip(uint256 pk, bytes32 challenge) public view {
        pk = bound(pk, 1, P256.N - 1);
        (uint256 x, uint256 y) = vm.publicKeyP256(pk);
        WebAuthn.Assertion memory a =
            _assert(pk, challenge, 0x05, ',"origin":"https://agentfromzero.netlify.app","crossOrigin":false}');
        assertTrue(h.verify(challenge, true, a, x, y));
        assertFalse(h.verify(bytes32(uint256(challenge) ^ 1), true, a, x, y));
    }

    function test_synthetic_uvRequired() public view {
        uint256 pk = 0xA11CE;
        (uint256 x, uint256 y) = vm.publicKeyP256(pk);
        WebAuthn.Assertion memory upOnly = _assert(pk, CHALLENGE, 0x01, "}");
        assertTrue(h.verify(CHALLENGE, false, upOnly, x, y), "UP-only is fine when UV not required");
        assertFalse(h.verify(CHALLENGE, true, upOnly, x, y), "UV required but flag absent");
        WebAuthn.Assertion memory noUP = _assert(pk, CHALLENGE, 0x04, "}");
        assertFalse(h.verify(CHALLENGE, false, noUP, x, y), "UP is always required");
    }
}

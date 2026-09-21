// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {P256} from "./P256.sol";

/// @title WebAuthn — verify a passkey assertion (navigator.credentials.get) on-chain
/// @notice The signed message of a WebAuthn assertion is
///           sha256(authenticatorData || sha256(clientDataJSON))
///         and the assertion is bound to our 32-byte challenge through `clientDataJSON.challenge`
///         (base64url, no padding). We verify:
///           1. clientDataJSON contains `"type":"webauthn.get"`;
///           2. clientDataJSON contains `"challenge":"<base64url(challenge)>"`;
///           3. authenticatorData flags have UP (user present, bit 0) set; UV (bit 2) is required
///              when `requireUV` is true;
///           4. the P256 signature verifies against the registered public key.
///         Origin / rpIdHash are NOT checked on-chain (v0): the challenge already binds the
///         assertion to one job and one contract, which is what the escrow needs.
/// @dev Verified in `test/WebAuthn.t.sol` against real Safari and Chrome passkey assertions (the
///      vectors Solady / Coinbase Smart Wallet use) plus fuzzed assertions signed with Foundry's
///      P256 signer; high-s twins, wrong challenge/type/key and missing UP/UV are all rejected.
///      Deliberately minimal (substring checks, no JSON parser): the challenge is a fixed 43-char
///      base64url token, so there is no escaping surface to exploit.
library WebAuthn {
    uint8 internal constant FLAG_UP = 0x01;
    uint8 internal constant FLAG_UV = 0x04;

    struct Assertion {
        bytes authenticatorData;
        bytes clientDataJSON;
        uint256 r;
        uint256 s;
    }

    /// @notice Returns true if `assertion` is a valid assertion over `challenge` by key (x, y).
    function verify(bytes32 challenge, bool requireUV, Assertion memory assertion, uint256 x, uint256 y)
        internal
        view
        returns (bool)
    {
        // 1-2. clientDataJSON checks (type + challenge). Cheap substring checks suffice because
        //      the challenge is a 43-char base64url string with no JSON-escaping surface.
        if (!_contains(assertion.clientDataJSON, bytes('"type":"webauthn.get"'))) return false;
        bytes memory expected = abi.encodePacked('"challenge":"', _base64Url(challenge), '"');
        if (!_contains(assertion.clientDataJSON, expected)) return false;

        // 3. authenticatorData: 32-byte rpIdHash | 1-byte flags | 4-byte signCount | ...
        if (assertion.authenticatorData.length < 37) return false;
        uint8 flags = uint8(assertion.authenticatorData[32]);
        if (flags & FLAG_UP == 0) return false;
        if (requireUV && flags & FLAG_UV == 0) return false;

        // 4. signature over sha256(authenticatorData || sha256(clientDataJSON))
        bytes32 message = sha256(abi.encodePacked(assertion.authenticatorData, sha256(assertion.clientDataJSON)));
        return P256.verify(message, assertion.r, assertion.s, x, y);
    }

    /// @dev Base64url (RFC 4648 §5, no padding) of 32 bytes -> 43 ASCII chars.
    function _base64Url(bytes32 data) internal pure returns (bytes memory out) {
        bytes memory table = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
        out = new bytes(43);
        uint256 o;
        for (uint256 i = 0; i < 30; i += 3) {
            uint256 n =
                (uint256(uint8(data[i])) << 16) | (uint256(uint8(data[i + 1])) << 8) | uint256(uint8(data[i + 2]));
            out[o++] = table[(n >> 18) & 63];
            out[o++] = table[(n >> 12) & 63];
            out[o++] = table[(n >> 6) & 63];
            out[o++] = table[n & 63];
        }
        // last 2 bytes -> 3 chars
        uint256 t = (uint256(uint8(data[30])) << 16) | (uint256(uint8(data[31])) << 8);
        out[o++] = table[(t >> 18) & 63];
        out[o++] = table[(t >> 12) & 63];
        out[o++] = table[(t >> 6) & 63];
    }

    /// @dev Naive substring search; inputs are < 1 KB so O(n*m) is fine.
    function _contains(bytes memory haystack, bytes memory needle) internal pure returns (bool) {
        if (needle.length == 0 || needle.length > haystack.length) return false;
        uint256 last = haystack.length - needle.length;
        for (uint256 i = 0; i <= last; i++) {
            bool match_ = true;
            for (uint256 j = 0; j < needle.length; j++) {
                if (haystack[i + j] != needle[j]) {
                    match_ = false;
                    break;
                }
            }
            if (match_) return true;
        }
        return false;
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title P256 — wrapper around Monad's secp256r1 precompile (EIP-7951, address 0x0100)
/// @notice Input is exactly 160 bytes: hash(32) | r(32) | s(32) | qx(32) | qy(32), all big-endian.
///         Returns 32 bytes `0x..01` on success, empty bytes on failure. Gas: 6900 on Monad.
///         Reference: https://docs.monad.xyz/developer-essentials/precompiles#p256-signature-verification
/// @dev Same address and interface as RIP-7212 (`0x100`), so this also works on RIP-7212 chains.
library P256 {
    address internal constant VERIFIER = address(0x0100);

    /// @dev secp256r1 group order n and n/2, used to enforce low-s (reject malleable signatures).
    uint256 internal constant N = 0xFFFFFFFF00000000FFFFFFFFFFFFFFFFBCE6FAADA7179E84F3B9CAC2FC632551;
    uint256 internal constant N_DIV_2 = 0x7FFFFFFF800000007FFFFFFFFFFFFFFFDE737D56D38BCF4279DCA3B9DECD5D1B;

    /// @notice Verifies `(r, s)` over `hash` for public key `(qx, qy)` via the precompile.
    /// @dev Rejects high-s signatures and zero components before touching the precompile so the
    ///      contract's acceptance set is unambiguous (WebAuthn authenticators may emit high-s;
    ///      normalise `s` client-side: if s > n/2 then s = n - s).
    function verify(bytes32 hash, uint256 r, uint256 s, uint256 qx, uint256 qy) internal view returns (bool ok) {
        if (r == 0 || s == 0 || r >= N || s > N_DIV_2) return false;
        (bool success, bytes memory result) = VERIFIER.staticcall(abi.encodePacked(hash, r, s, qx, qy));
        ok = success && result.length == 32 && abi.decode(result, (uint256)) == 1;
    }
}

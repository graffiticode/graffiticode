// SPDX-License-Identifier: MIT

//! Decrypts secret values written by the console (`get-val-private`). Must stay in lockstep
//! with the console's `src/lib/secret-crypto.ts`. Two ciphertext formats are understood:
//!
//! ```text
//! legacy   : <ivHex>:<encHex>                 AES-256-CBC, deterministic IV, key version 1
//! versioned: v<N>:<ivHex>:<ctHex>:<tagHex>    AES-256-GCM, authenticated
//! ```
//!
//! This side only decrypts; the console encrypts.

use std::collections::HashMap;

use aes::cipher::{BlockModeDecrypt, KeyIvInit, block_padding::Pkcs7};
use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use sha2::{Digest, Sha256};

type Aes256CbcDec = cbc::Decryptor<aes::Aes256>;

/// AES keys by version, each derived from a secret as its SHA-256.
#[derive(Clone, Default)]
pub struct Keyring {
    keys: HashMap<u32, [u8; 32]>,
}

impl std::fmt::Debug for Keyring {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let mut versions: Vec<_> = self.keys.keys().collect();
        versions.sort();
        f.debug_struct("Keyring").field("versions", &versions).finish()
    }
}

impl Keyring {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn with_secret(mut self, version: u32, secret: &str) -> Self {
        self.keys.insert(version, Sha256::digest(secret).into());
        self
    }

    /// Version 1 from `GRAFFITICODE_SECRET_KEY`; later versions from `GRAFFITICODE_SECRET_KEYS`,
    /// a JSON object such as `{"2": "<secret2>"}`.
    pub fn from_env() -> Self {
        let mut keyring = Self::new();
        if let Ok(secret) = std::env::var("GRAFFITICODE_SECRET_KEY")
            && !secret.is_empty()
        {
            keyring = keyring.with_secret(1, &secret);
        }
        let later: HashMap<String, String> = std::env::var("GRAFFITICODE_SECRET_KEYS")
            .ok()
            .and_then(|raw| serde_json::from_str(&raw).ok())
            .unwrap_or_default();
        for (version, secret) in later {
            match version.parse() {
                Ok(version) if version > 1 && !secret.is_empty() => keyring = keyring.with_secret(version, &secret),
                _ => {}
            }
        }
        keyring
    }

    /// The plaintext, or `None` if the text is not a ciphertext this keyring can open: no key
    /// for its version, the wrong key, or tampered bytes.
    pub fn decrypt(&self, ciphertext: &str) -> Option<String> {
        let parts: Vec<&str> = ciphertext.split(':').collect();
        let plaintext = match version(parts[0]) {
            Some(version) => {
                let [_, iv, ct, tag] = parts[..] else { return None };
                let cipher = Aes256Gcm::new(self.keys.get(&version)?.into());
                let iv: [u8; 12] = hex::decode(iv).ok()?.try_into().ok()?;
                let mut sealed = hex::decode(ct).ok()?;
                sealed.extend(hex::decode(tag).ok()?);
                cipher.decrypt(&Nonce::from(iv), sealed.as_slice()).ok()?
            }
            None => {
                let [iv, enc, ..] = parts[..] else { return None };
                let iv: [u8; 16] = hex::decode(iv).ok()?.try_into().ok()?;
                let mut buf = hex::decode(enc).ok()?;
                let cipher = Aes256CbcDec::new(self.keys.get(&1)?.into(), &iv.into());
                cipher.decrypt_padded::<Pkcs7>(&mut buf).ok()?.to_vec()
            }
        };
        String::from_utf8(plaintext).ok()
    }
}

/// `v<N>` → `N`.
fn version(prefix: &str) -> Option<u32> {
    let digits = prefix.strip_prefix('v')?;
    (!digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit())).then(|| digits.parse().ok())?
}

#[cfg(test)]
mod tests {
    use super::*;

    // Ciphertexts produced by Node's `crypto` with the console's parameters, for the plaintext
    // "s3cret value" under the secrets "key-one" (v1) and "key-two" (v2).
    const LEGACY: &str = include_str!("../tests/secret/legacy.txt");
    const VERSIONED: &str = include_str!("../tests/secret/v2.txt");

    fn keyring() -> Keyring {
        Keyring::new().with_secret(1, "key-one").with_secret(2, "key-two")
    }

    #[test]
    fn opens_both_formats() {
        assert_eq!(keyring().decrypt(LEGACY.trim()).as_deref(), Some("s3cret value"));
        assert_eq!(keyring().decrypt(VERSIONED.trim()).as_deref(), Some("s3cret value"));
    }

    #[test]
    fn refuses_what_it_cannot_open() {
        let versioned = VERSIONED.trim();
        assert_eq!(Keyring::new().decrypt(versioned), None);
        assert_eq!(Keyring::new().with_secret(2, "wrong").decrypt(versioned), None);
        let tampered = versioned.replacen(":0", ":1", 1).replacen(":a", ":b", 1);
        assert_ne!(tampered, versioned);
        assert_eq!(keyring().decrypt(&tampered), None);
        for not_ciphertext in ["plain text", "", "v2:zz:zz:zz", "abcd:1234"] {
            assert_eq!(keyring().decrypt(not_ciphertext), None, "{not_ciphertext:?}");
        }
    }
}

//! smart-account-lite — a minimal custom account (C-address) demonstrating the
//! full warden loop on-chain: owner passkey-style root authority + session
//! signers whose every authorization passes deny-by-default rules inside
//! `__check_auth`.
//!
//! This is the v1 install target. Its compact rules cover what the
//! synthesizer infers — any number of exact/allowlist argument matches per
//! rule (compared as raw values, so every argument type works) plus ONE
//! rolling cap per rule. Specs with several caps on one rule run through the
//! generated-crate path and, on the roadmap, an OpenZeppelin smart-accounts
//! adapter.
#![no_std]

use policy_core::{arg_i128, Counters};
use soroban_sdk::auth::{Context, CustomAccountInterface};
use soroban_sdk::crypto::Hash;
use soroban_sdk::{
    contract, contracterror, contractimpl, contracttype, Address, BytesN, Env, Symbol, Val, Vec,
};

/// u32::MAX sentinel meaning "no cap on this rule" — mirrored in @warden/sdk.
const NONE: u32 = u32::MAX;

/// Argument `index` must equal one of `allowed` (one entry = exact match).
#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ArgMatch {
    pub allowed: Vec<Val>,
    pub index: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StoredRule {
    pub arg_count: u32,
    pub cap: i128,
    pub cap_index: u32,
    pub contract: Address,
    pub function: Symbol,
    pub matches: Vec<ArgMatch>,
    pub window: u64,
}

#[contracttype]
#[derive(Clone)]
pub struct SessionSigner {
    pub expires_ledger: u32,
    pub rules: Vec<StoredRule>,
}

#[contracttype]
#[derive(Clone)]
pub enum DataKey {
    Owner,
    Signer(BytesN<32>),
    /// Rolling counters of one session signer (persistent storage).
    Counters(BytesN<32>),
}

#[contracterror]
#[derive(Copy, Clone, Debug, Eq, PartialEq)]
#[repr(u32)]
pub enum AccError {
    NotInitialized = 1,
    AlreadyInitialized = 2,
    UnknownSigner = 3,
    SignerExpired = 4,
    UnsupportedContext = 5,
    NoMatchingRule = 6,
    ArgCountMismatch = 7,
    ArgNotAllowed = 8,
    BadArgType = 9,
    CapExceeded = 10,
}

#[contracttype]
#[derive(Clone)]
pub struct AccSignature {
    pub public_key: BytesN<32>,
    pub signature: BytesN<64>,
}

#[contract]
pub struct SmartAccountLite;

#[contractimpl]
impl SmartAccountLite {
    /// One-time initialization with the owner's ed25519 public key.
    /// (A passkey/secp256r1 owner variant is a drop-in change; ed25519 keeps
    /// the reference implementation dependency-free.)
    pub fn init(env: Env, owner: BytesN<32>) {
        if env.storage().instance().has(&DataKey::Owner) {
            panic_with(AccError::AlreadyInitialized)
        }
        env.storage().instance().set(&DataKey::Owner, &owner);
    }

    /// Register (or replace) a session signer with its compact rules.
    /// Authorized by the account itself — i.e., the OWNER's signature — which
    /// is exactly what the unsigned tx from `@warden/sdk` requires.
    pub fn add_signer(env: Env, pk: BytesN<32>, expires_ledger: u32, rules: Vec<StoredRule>) {
        env.current_contract_address().require_auth();
        // Counters are keyed by rule position, so new rules start from zero.
        env.storage().persistent().remove(&DataKey::Counters(pk.clone()));
        env.storage()
            .instance()
            .set(&DataKey::Signer(pk), &SessionSigner { expires_ledger, rules });
    }

    pub fn remove_signer(env: Env, pk: BytesN<32>) {
        env.current_contract_address().require_auth();
        env.storage().persistent().remove(&DataKey::Counters(pk.clone()));
        env.storage().instance().remove(&DataKey::Signer(pk));
    }

    pub fn owner(env: Env) -> BytesN<32> {
        env.storage()
            .instance()
            .get(&DataKey::Owner)
            .unwrap_or_else(|| panic_with(AccError::NotInitialized))
    }
}

#[contractimpl]
impl CustomAccountInterface for SmartAccountLite {
    type Signature = AccSignature;
    type Error = AccError;

    /// The only gate into this account. Validators invoke this during
    /// consensus for every operation that requires the account's auth.
    fn __check_auth(
        env: Env,
        signature_payload: Hash<32>,
        signature: AccSignature,
        auth_contexts: Vec<Context>,
    ) -> Result<(), AccError> {
        // 1. Cryptographic identity — panics on an invalid signature.
        env.crypto().ed25519_verify(
            &signature.public_key,
            &signature_payload.clone().into(),
            &signature.signature,
        );

        // 2. Owner short-circuit: root authority, no rules.
        let owner: BytesN<32> = env
            .storage()
            .instance()
            .get(&DataKey::Owner)
            .ok_or(AccError::NotInitialized)?;
        if owner == signature.public_key {
            return Ok(());
        }

        // 3. Session signer: must exist and be unexpired.
        let signer: SessionSigner = env
            .storage()
            .instance()
            .get(&DataKey::Signer(signature.public_key.clone()))
            .ok_or(AccError::UnknownSigner)?;
        if signer.expires_ledger != 0 && env.ledger().sequence() > signer.expires_ledger {
            return Err(AccError::SignerExpired);
        }

        // 4. Deny-by-default rule enforcement over EVERY context in the tree.
        let counters_key = DataKey::Counters(signature.public_key);
        let mut counters = Counters::load_from(&env, &counters_key);
        for ctx in auth_contexts.iter() {
            enforce_rules(&env, &signer.rules, &ctx, &mut counters)?;
        }
        counters.save_to(&env, &counters_key);
        Ok(())
    }
}

pub fn enforce_rules(
    env: &Env,
    rules: &Vec<StoredRule>,
    ctx: &Context,
    counters: &mut Counters,
) -> Result<(), AccError> {
    let cc = match ctx {
        Context::Contract(cc) => cc,
        _ => return Err(AccError::UnsupportedContext),
    };
    for (i, rule) in rules.iter().enumerate() {
        if rule.contract != cc.contract || rule.function != cc.fn_name {
            continue;
        }
        if cc.args.len() != rule.arg_count {
            return Err(AccError::ArgCountMismatch);
        }
        for m in rule.matches.iter() {
            let arg = cc.args.get(m.index).ok_or(AccError::BadArgType)?;
            // Host-side deep comparison: equal type AND equal value.
            if !m.allowed.contains(arg) {
                return Err(AccError::ArgNotAllowed);
            }
        }
        if rule.cap_index != NONE && rule.cap > 0 {
            let amount = arg_i128(env, &cc.args, rule.cap_index).ok_or(AccError::BadArgType)?;
            // One cap per rule, so the rule's position identifies its counter:
            // two rules on the same function never share (or reset) a window.
            if !counters.add_checked(
                env,
                rule.function.clone(),
                i as u32,
                rule.window,
                amount,
                rule.cap,
            ) {
                return Err(AccError::CapExceeded);
            }
        }
        return Ok(());
    }
    Err(AccError::NoMatchingRule)
}

fn panic_with(e: AccError) -> ! {
    panic!("{:?}", e)
}

#[cfg(test)]
mod test;

//! warden-policy-core — primitives every synthesized policy links against.
//!
//! Nothing here is generated; this crate is hand-written, small, and meant to
//! be audited once. Generated code composes these pieces, so the audit surface
//! of the whole system stays: (this crate) + (smart-account-lite) + (the
//! synthesizer templates) — not every generated policy.
#![no_std]

use soroban_sdk::{
    contracttype, symbol_short, Address, Bytes, Env, IntoVal, Map, String, Symbol, TryFromVal, Val, Vec,
};

// ---------------------------------------------------------------------------
// Rolling-window counters
// ---------------------------------------------------------------------------

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CounterKey {
    pub rule: Symbol,
    pub arg: u32,
}

#[contracttype]
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CounterVal {
    pub window_start: u64,
    pub spent: i128,
}

/// Rolling-sum counters keyed by (rule, argIndex).
///
/// Semantics (mirrored exactly by the TS reference evaluator — divergence is
/// a release-blocking bug):
///   - a window starts at the first counted call and lasts `window_secs`
///   - once `now - window_start >= window_secs`, the counter resets
///   - `window_secs == 0` means per-call: every call sees a fresh counter
///   - negative amounts never pass; sums are overflow-checked
pub struct Counters {
    map: Map<CounterKey, CounterVal>,
}

const COUNTERS_KEY: Symbol = symbol_short!("wardencnt");

impl Counters {
    pub fn new(env: &Env) -> Self {
        Self { map: Map::new(env) }
    }

    /// Load persisted counters from the current contract's persistent storage
    /// (used by smart-account-lite inside `__check_auth`).
    pub fn load(env: &Env) -> Self {
        let map = env
            .storage()
            .persistent()
            .get::<Symbol, Map<CounterKey, CounterVal>>(&COUNTERS_KEY)
            .unwrap_or_else(|| Map::new(env));
        Self { map }
    }

    pub fn save(&self, env: &Env) {
        env.storage().persistent().set(&COUNTERS_KEY, &self.map);
    }

    /// Like `load`/`save`, under a caller-chosen key — lets an account keep
    /// one counter set per signer so signers cannot drain each other's caps.
    pub fn load_from<K: IntoVal<Env, Val>>(env: &Env, key: &K) -> Self {
        let map = env
            .storage()
            .persistent()
            .get::<K, Map<CounterKey, CounterVal>>(key)
            .unwrap_or_else(|| Map::new(env));
        Self { map }
    }

    pub fn save_to<K: IntoVal<Env, Val>>(&self, env: &Env, key: &K) {
        env.storage().persistent().set(key, &self.map);
    }

    /// Returns true iff `amount` fits under `cap` within the current window,
    /// and records it. False leaves no trace (callers deny the whole auth).
    pub fn add_checked(
        &mut self,
        env: &Env,
        rule: Symbol,
        arg: u32,
        window_secs: u64,
        amount: i128,
        cap: i128,
    ) -> bool {
        if amount < 0 {
            return false;
        }
        let now = env.ledger().timestamp();
        let key = CounterKey { rule, arg };
        let (mut start, mut spent) = match self.map.get(key.clone()) {
            Some(v) => (v.window_start, v.spent),
            None => (now, 0i128),
        };
        if window_secs == 0 || now.saturating_sub(start) >= window_secs {
            start = now;
            spent = 0;
        }
        match spent.checked_add(amount) {
            Some(total) if total <= cap => {
                self.map.set(key, CounterVal { window_start: start, spent: total });
                true
            }
            _ => false,
        }
    }
}

// ---------------------------------------------------------------------------
// Typed argument accessors (None = wrong type or out of range → caller denies)
// ---------------------------------------------------------------------------

macro_rules! arg_accessor {
    ($name:ident, $ty:ty) => {
        pub fn $name(env: &Env, args: &Vec<Val>, i: u32) -> Option<$ty> {
            let v = args.get(i)?;
            <$ty>::try_from_val(env, &v).ok()
        }
    };
}

arg_accessor!(arg_address, Address);
arg_accessor!(arg_i128, i128);
arg_accessor!(arg_u64, u64);
arg_accessor!(arg_u32, u32);
arg_accessor!(arg_symbol, Symbol);
arg_accessor!(arg_string, String);
arg_accessor!(arg_bool, bool);
arg_accessor!(arg_bytes, Bytes);

// ---------------------------------------------------------------------------

#[cfg(test)]
mod test {
    use super::*;
    use soroban_sdk::testutils::Ledger;
    use soroban_sdk::{vec, Env};

    fn env_at(ts: u64) -> Env {
        let env = Env::default();
        env.ledger().with_mut(|li| li.timestamp = ts);
        env
    }

    #[test]
    fn cap_accumulates_and_denies_overflow() {
        let env = env_at(1_000_000);
        let mut c = Counters::new(&env);
        let r = symbol_short!("r1");
        assert!(c.add_checked(&env, r.clone(), 2, 604_800, 100, 150));
        assert!(c.add_checked(&env, r.clone(), 2, 604_800, 50, 150)); // exactly at cap
        assert!(!c.add_checked(&env, r.clone(), 2, 604_800, 1, 150)); // over
    }

    #[test]
    fn window_resets_after_elapse() {
        let env = env_at(1_000_000);
        let mut c = Counters::new(&env);
        let r = symbol_short!("r1");
        assert!(c.add_checked(&env, r.clone(), 0, 604_800, 150, 150));
        assert!(!c.add_checked(&env, r.clone(), 0, 604_800, 1, 150));
        env.ledger().with_mut(|li| li.timestamp += 604_801);
        assert!(c.add_checked(&env, r.clone(), 0, 604_800, 150, 150));
    }

    #[test]
    fn per_call_window_never_accumulates() {
        let env = env_at(1_000_000);
        let mut c = Counters::new(&env);
        let r = symbol_short!("r1");
        assert!(c.add_checked(&env, r.clone(), 0, 0, 150, 150));
        assert!(c.add_checked(&env, r.clone(), 0, 0, 150, 150));
        assert!(!c.add_checked(&env, r.clone(), 0, 0, 151, 150));
    }

    #[test]
    fn negative_and_overflowing_amounts_deny() {
        let env = env_at(1_000_000);
        let mut c = Counters::new(&env);
        let r = symbol_short!("r1");
        assert!(!c.add_checked(&env, r.clone(), 0, 0, -1, 150));
        assert!(c.add_checked(&env, r.clone(), 1, 3600, 1, i128::MAX));
        assert!(!c.add_checked(&env, r.clone(), 1, 3600, i128::MAX, i128::MAX));
    }

    #[test]
    fn typed_accessors_reject_wrong_types() {
        let env = env_at(0);
        let args: Vec<Val> = vec![&env, 5i128.into_val(&env), true.into_val(&env)];
        assert_eq!(arg_i128(&env, &args, 0), Some(5));
        assert_eq!(arg_bool(&env, &args, 1), Some(true));
        assert_eq!(arg_i128(&env, &args, 1), None); // bool is not i128
        assert_eq!(arg_address(&env, &args, 0), None); // i128 is not Address
        assert_eq!(arg_i128(&env, &args, 9), None); // out of range
    }
}

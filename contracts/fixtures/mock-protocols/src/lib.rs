//! Deliberately tiny stand-ins for a SEP-41 token and a yield pool, used by
//! the examples and testnet walkthroughs. Not production contracts.
#![no_std]
use soroban_sdk::{contract, contractimpl, contracttype, Address, Env};

#[contracttype]
#[derive(Clone)]
pub enum Key {
    Balance(Address),
    Yield(Address),
}

#[contract]
pub struct MockToken;

#[contractimpl]
impl MockToken {
    pub fn mint(env: Env, to: Address, amount: i128) {
        let key = Key::Balance(to);
        let bal: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        env.storage().persistent().set(&key, &(bal + amount));
    }

    pub fn balance(env: Env, of: Address) -> i128 {
        env.storage().persistent().get(&Key::Balance(of)).unwrap_or(0)
    }

    /// SEP-41 shaped transfer: `from.require_auth()` is what routes execution
    /// through the smart account's `__check_auth` when `from` is a C-address.
    pub fn transfer(env: Env, from: Address, to: Address, amount: i128) {
        from.require_auth();
        let fk = Key::Balance(from.clone());
        let tk = Key::Balance(to);
        let fb: i128 = env.storage().persistent().get(&fk).unwrap_or(0);
        assert!(amount >= 0 && fb >= amount, "insufficient balance");
        let tb: i128 = env.storage().persistent().get(&tk).unwrap_or(0);
        env.storage().persistent().set(&fk, &(fb - amount));
        env.storage().persistent().set(&tk, &(tb + amount));
    }
}

#[contract]
pub struct MockPool;

#[contractimpl]
impl MockPool {
    pub fn set_yield(env: Env, user: Address, amount: i128) {
        env.storage().persistent().set(&Key::Yield(user), &amount);
    }

    /// Blend-shaped claim: authorized by the claiming user.
    pub fn claim(env: Env, user: Address, _reserve_id: u32) -> i128 {
        user.require_auth();
        let key = Key::Yield(user.clone());
        let amount: i128 = env.storage().persistent().get(&key).unwrap_or(0);
        env.storage().persistent().set(&key, &0i128);
        amount
    }
}

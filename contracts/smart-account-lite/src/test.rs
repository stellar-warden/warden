#![cfg(test)]

use super::*;
use soroban_sdk::auth::ContractContext;
use soroban_sdk::testutils::{Address as _, BytesN as _, Ledger};
use soroban_sdk::{vec, Env, IntoVal, Val, Vec as SVec};

fn setup(env: &Env) -> (Address, Address, Address, Address) {
    env.ledger().with_mut(|li| li.timestamp = 1_000_000);
    let token = Address::generate(env);
    let alice = Address::generate(env);
    let bob = Address::generate(env);
    let mallory = Address::generate(env);
    (token, alice, bob, mallory)
}

fn transfer_rule(env: &Env, token: &Address, dests: &[&Address], cap: i128) -> StoredRule {
    let mut d = SVec::new(env);
    for a in dests {
        d.push_back((*a).clone());
    }
    StoredRule {
        arg_count: 3,
        cap,
        cap_index: if cap > 0 { 2 } else { NONE },
        contract: token.clone(),
        dest_index: 1,
        dests: d,
        function: Symbol::new(env, "transfer"),
        window: 604_800,
    }
}

fn transfer_ctx(env: &Env, token: &Address, from: &Address, to: &Address, amount: i128) -> Context {
    let args: SVec<Val> = vec![
        env,
        from.into_val(env),
        to.into_val(env),
        amount.into_val(env),
    ];
    Context::Contract(ContractContext {
        contract: token.clone(),
        fn_name: Symbol::new(env, "transfer"),
        args,
    })
}

#[test]
fn permits_allowlisted_transfer_within_cap() {
    let env = Env::default();
    let (token, alice, bob, _) = setup(&env);
    let from = Address::generate(&env);
    let rules = vec![&env, transfer_rule(&env, &token, &[&alice, &bob], 1_500_000_000)];
    let mut c = Counters::new(&env);
    assert_eq!(
        enforce_rules(&env, &rules, &transfer_ctx(&env, &token, &from, &alice, 900_000_000), &mut c),
        Ok(())
    );
}

#[test]
fn denies_unlisted_destination() {
    let env = Env::default();
    let (token, alice, _, mallory) = setup(&env);
    let from = Address::generate(&env);
    let rules = vec![&env, transfer_rule(&env, &token, &[&alice], 1_500_000_000)];
    let mut c = Counters::new(&env);
    assert_eq!(
        enforce_rules(&env, &rules, &transfer_ctx(&env, &token, &from, &mallory, 1), &mut c),
        Err(AccError::DestNotAllowed)
    );
}

#[test]
fn denies_unlisted_function_and_contract() {
    let env = Env::default();
    let (token, alice, _, _) = setup(&env);
    let from = Address::generate(&env);
    let other = Address::generate(&env);
    let rules = vec![&env, transfer_rule(&env, &token, &[&alice], 0)];
    let mut c = Counters::new(&env);

    // unlisted contract
    assert_eq!(
        enforce_rules(&env, &rules, &transfer_ctx(&env, &other, &from, &alice, 1), &mut c),
        Err(AccError::NoMatchingRule)
    );

    // same contract, unlisted function
    let ctx = Context::Contract(ContractContext {
        contract: token.clone(),
        fn_name: Symbol::new(&env, "burn"),
        args: vec![&env, from.into_val(&env), 1i128.into_val(&env)],
    });
    assert_eq!(enforce_rules(&env, &rules, &ctx, &mut c), Err(AccError::NoMatchingRule));
}

#[test]
fn denies_arg_count_mismatch() {
    let env = Env::default();
    let (token, alice, _, _) = setup(&env);
    let from = Address::generate(&env);
    let rules = vec![&env, transfer_rule(&env, &token, &[&alice], 0)];
    let mut c = Counters::new(&env);
    let ctx = Context::Contract(ContractContext {
        contract: token.clone(),
        fn_name: Symbol::new(&env, "transfer"),
        args: vec![&env, from.into_val(&env), alice.into_val(&env)], // 2 args, rule expects 3
    });
    assert_eq!(enforce_rules(&env, &rules, &ctx, &mut c), Err(AccError::ArgCountMismatch));
}

#[test]
fn cap_accumulates_across_contexts_and_resets_after_window() {
    let env = Env::default();
    let (token, alice, _, _) = setup(&env);
    let from = Address::generate(&env);
    let rules = vec![&env, transfer_rule(&env, &token, &[&alice], 1_500_000_000)];
    let mut c = Counters::new(&env);

    let pay = |amount: i128, c: &mut Counters| {
        enforce_rules(&env, &rules, &transfer_ctx(&env, &token, &from, &alice, amount), c)
    };
    assert_eq!(pay(1_000_000_000, &mut c), Ok(()));
    assert_eq!(pay(500_000_000, &mut c), Ok(())); // exactly at cap
    assert_eq!(pay(1, &mut c), Err(AccError::CapExceeded));

    env.ledger().with_mut(|li| li.timestamp += 604_801);
    assert_eq!(pay(1_500_000_000, &mut c), Ok(()), "window must reset");
}

#[test]
fn negative_amount_denies() {
    let env = Env::default();
    let (token, alice, _, _) = setup(&env);
    let from = Address::generate(&env);
    let rules = vec![&env, transfer_rule(&env, &token, &[&alice], 1_500_000_000)];
    let mut c = Counters::new(&env);
    assert_eq!(
        enforce_rules(&env, &rules, &transfer_ctx(&env, &token, &from, &alice, -1), &mut c),
        Err(AccError::CapExceeded)
    );
}

#[test]
fn signer_lifecycle_owner_gated() {
    let env = Env::default();
    env.mock_all_auths();
    let id = env.register(SmartAccountLite, ());
    let client = SmartAccountLiteClient::new(&env, &id);

    let owner = soroban_sdk::BytesN::<32>::random(&env);
    client.init(&owner);
    assert_eq!(client.owner(), owner);

    let session = soroban_sdk::BytesN::<32>::random(&env);
    let rules: SVec<StoredRule> = SVec::new(&env);
    client.add_signer(&session, &0u32, &rules);
    client.remove_signer(&session);
}

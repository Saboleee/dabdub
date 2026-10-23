#![cfg(test)]

use crate::{SlippageProtectionContract, SlippageProtectionContractClient};
use soroban_sdk::{testutils::Address as _, Address, Env, Symbol};

fn setup_env() -> (Env, SlippageProtectionContractClient<'static>, Address) {
    let env = Env::default();
    env.mock_all_auths();

    let admin = Address::generate(&env);
    let contract_id = env.register(SlippageProtectionContract, (&admin,));
    let client = SlippageProtectionContractClient::new(&env, &contract_id);

    (env, client, admin)
}

// ── constructor ──────────────────────────────────────────────────────────────

#[test]
fn test_constructor_defaults() {
    let (_env, client, admin) = setup_env();
    assert_eq!(client.get_max_slippage(), 100);
    assert_eq!(client.get_admin(), admin);
}

// ── check_slippage: happy paths ──────────────────────────────────────────────

#[test]
fn test_check_slippage_exact_boundary_passes() {
    // deviation == max_bps (100 bps = 1%) → should NOT revert
    let (_env, client, _admin) = setup_env();
    // actual is exactly 1% below expected: 10_000 → 9_900
    client.check_slippage(&10_000, &9_900);
}

#[test]
fn test_check_slippage_within_tolerance_passes() {
    let (_env, client, _admin) = setup_env();
    // 0.5% deviation — well within 1%
    client.check_slippage(&10_000, &9_950);
}

#[test]
fn test_check_slippage_zero_deviation_passes() {
    let (_env, client, _admin) = setup_env();
    client.check_slippage(&10_000, &10_000);
}

// ── check_slippage: revert paths ─────────────────────────────────────────────

#[test]
#[should_panic(expected = "SlippageExceeded")]
fn test_check_slippage_one_bps_over_reverts() {
    // deviation == 101 bps → must revert
    let (_env, client, _admin) = setup_env();
    // 101 bps below: 10_000 → 9_899
    client.check_slippage(&10_000, &9_899);
}

#[test]
#[should_panic(expected = "SlippageExceeded")]
fn test_check_slippage_large_deviation_reverts() {
    let (_env, client, _admin) = setup_env();
    client.check_slippage(&10_000, &5_000); // 50% deviation
}

#[test]
#[should_panic(expected = "expected must be > 0")]
fn test_check_slippage_zero_expected_reverts() {
    let (_env, client, _admin) = setup_env();
    client.check_slippage(&0, &100);
}

// ── set_max_slippage ─────────────────────────────────────────────────────────

#[test]
fn test_admin_can_tighten_slippage() {
    let (_env, client, admin) = setup_env();
    client.set_max_slippage(&admin, &50); // tighten to 0.5%
    assert_eq!(client.get_max_slippage(), 50);
}

#[test]
fn test_admin_can_relax_slippage() {
    let (_env, client, admin) = setup_env();
    client.set_max_slippage(&admin, &300); // relax to 3%
    assert_eq!(client.get_max_slippage(), 300);
}

#[test]
#[should_panic(expected = "bps must be <= 10000")]
fn test_admin_cannot_set_slippage_above_bps_denominator() {
    let (_env, client, admin) = setup_env();
    client.set_max_slippage(&admin, &10_001);
}

#[test]
fn test_tightened_slippage_rejects_previously_valid_swap() {
    let (_env, client, admin) = setup_env();
    // 0.8% deviation passes at default 1%
    client.check_slippage(&10_000, &9_920);
    // tighten to 0.5%
    client.set_max_slippage(&admin, &50);
    // now same deviation should revert — tested separately below
    assert_eq!(client.get_max_slippage(), 50);
}

#[test]
#[should_panic(expected = "SlippageExceeded")]
fn test_tightened_slippage_reverts_swap() {
    let (_env, client, admin) = setup_env();
    client.set_max_slippage(&admin, &50); // 0.5%
                                          // 0.8% deviation → should now revert
    client.check_slippage(&10_000, &9_920);
}

#[test]
#[should_panic(expected = "Not admin")]
fn test_non_admin_cannot_set_slippage() {
    let (env, client, _admin) = setup_env();
    let random = Address::generate(&env);
    client.set_max_slippage(&random, &200);
}

#[test]
#[should_panic(expected = "bps must be <= 10000")]
fn test_set_max_slippage_rejects_out_of_range_bps() {
    let (_env, client, admin) = setup_env();
    client.set_max_slippage(&admin, &10_001);
}

// ── per-pair slippage: XLM/USDC ──────────────────────────────────────────────

#[test]
fn test_xlm_usdc_pair_falls_back_to_global_max() {
    let (env, client, _admin) = setup_env();
    let pair = Symbol::new(&env, "XLM_USDC");
    // No per-pair override → falls back to global 100 bps.
    assert_eq!(client.get_pair_max_slippage(&pair), 100);
    // 1% deviation passes at the global default.
    client.check_slippage_for_pair(&pair, &10_000, &9_900);
}

#[test]
fn test_xlm_usdc_pair_uses_admin_override() {
    let (env, client, admin) = setup_env();
    let pair = Symbol::new(&env, "XLM_USDC");
    client.set_pair_max_slippage(&admin, &pair, &30); // 0.3%
    assert_eq!(client.get_pair_max_slippage(&pair), 30);
    // 0.2% deviation passes under the tighter per-pair limit.
    client.check_slippage_for_pair(&pair, &10_000, &9_980);
}

#[test]
#[should_panic(expected = "SlippageExceeded")]
fn test_xlm_usdc_pair_override_rejects_over_limit() {
    let (env, client, admin) = setup_env();
    let pair = Symbol::new(&env, "XLM_USDC");
    client.set_pair_max_slippage(&admin, &pair, &30); // 0.3%
    // 0.5% deviation exceeds the per-pair limit even though it is within global.
    client.check_slippage_for_pair(&pair, &10_000, &9_950);
}

// ── per-pair slippage: USDC/NGN ──────────────────────────────────────────────

#[test]
fn test_usdc_ngn_pair_falls_back_to_global_max() {
    let (env, client, _admin) = setup_env();
    let pair = Symbol::new(&env, "USDC_NGN");
    assert_eq!(client.get_pair_max_slippage(&pair), 100);
    client.check_slippage_for_pair(&pair, &10_000, &9_900);
}

#[test]
fn test_usdc_ngn_pair_uses_admin_override() {
    let (env, client, admin) = setup_env();
    let pair = Symbol::new(&env, "USDC_NGN");
    client.set_pair_max_slippage(&admin, &pair, &250); // 2.5%
    assert_eq!(client.get_pair_max_slippage(&pair), 250);
    // 2% deviation passes under the relaxed per-pair limit.
    client.check_slippage_for_pair(&pair, &10_000, &9_800);
}

#[test]
#[should_panic(expected = "SlippageExceeded")]
fn test_usdc_ngn_pair_override_rejects_over_limit() {
    let (env, client, admin) = setup_env();
    let pair = Symbol::new(&env, "USDC_NGN");
    client.set_pair_max_slippage(&admin, &pair, &250); // 2.5%
    // 3% deviation exceeds the per-pair limit.
    client.check_slippage_for_pair(&pair, &10_000, &9_700);
}

#[test]
#[should_panic(expected = "Not admin")]
fn test_non_admin_cannot_set_pair_slippage() {
    let (env, client, _admin) = setup_env();
    let pair = Symbol::new(&env, "XLM_USDC");
    let random = Address::generate(&env);
    client.set_pair_max_slippage(&random, &pair, &50);
}

#[test]
#[should_panic(expected = "bps must be <= 10000")]
fn test_set_pair_max_slippage_rejects_out_of_range_bps() {
    let (env, client, admin) = setup_env();
    let pair = Symbol::new(&env, "XLM_USDC");
    client.set_pair_max_slippage(&admin, &pair, &10_001);
}

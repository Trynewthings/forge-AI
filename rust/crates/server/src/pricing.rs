//! Hardcoded pricing table for the usage panel.
//!
//! Values are USD per 1M tokens, input and output separately. Pricing
//! changes often — this is a "rough estimate" knob, not invoicing. The
//! match is by substring (case-insensitive) so versioned model IDs like
//! `claude-opus-4-6-20251215` still resolve to the right tier.
//!
//! When a model name doesn't match anything we return `None` and the UI
//! shows `—` for the cost cell. Adding a new model = one row here.

#[derive(Debug, Clone, Copy)]
pub struct PriceUsd {
    /// USD per 1M input tokens.
    pub input_per_million: f64,
    /// USD per 1M output tokens.
    pub output_per_million: f64,
}

/// Lookup price by model identifier. Matches longest-prefix-style on the
/// canonical name (lowercased substring), so `claude-opus-4-6` matches
/// before falling back to `claude-opus`.
#[must_use]
pub fn lookup(model: &str) -> Option<PriceUsd> {
    let m = model.to_lowercase();
    // Order matters — more-specific keys first.
    for (key, price) in TABLE {
        if m.contains(key) {
            return Some(*price);
        }
    }
    None
}

/// Estimate USD cost for an (input, output) token count under the given
/// model. Returns `None` if the model isn't priced.
#[must_use]
pub fn estimate_cost(model: &str, input_tokens: u64, output_tokens: u64) -> Option<f64> {
    let price = lookup(model)?;
    let cost = (input_tokens as f64 * price.input_per_million
        + output_tokens as f64 * price.output_per_million)
        / 1_000_000.0;
    Some(cost)
}

/// Static table. Numbers reflect May 2026 list prices for the most-common
/// SKUs we expose in `claw`; refresh as needed. The key is the substring
/// we look for in the model name.
const TABLE: &[(&str, PriceUsd)] = &[
    // ---- Anthropic ----
    ("claude-opus-4", PriceUsd { input_per_million: 15.0, output_per_million: 75.0 }),
    ("claude-sonnet-4", PriceUsd { input_per_million: 3.0, output_per_million: 15.0 }),
    ("claude-haiku-4", PriceUsd { input_per_million: 0.80, output_per_million: 4.0 }),
    ("opus", PriceUsd { input_per_million: 15.0, output_per_million: 75.0 }),
    ("sonnet", PriceUsd { input_per_million: 3.0, output_per_million: 15.0 }),
    ("haiku", PriceUsd { input_per_million: 0.80, output_per_million: 4.0 }),
    // ---- OpenAI ----
    ("gpt-4o-mini", PriceUsd { input_per_million: 0.15, output_per_million: 0.60 }),
    ("gpt-4o", PriceUsd { input_per_million: 2.50, output_per_million: 10.0 }),
    ("o3-mini", PriceUsd { input_per_million: 1.10, output_per_million: 4.40 }),
    ("o3", PriceUsd { input_per_million: 2.00, output_per_million: 8.00 }),
    // ---- DeepSeek ----
    ("deepseek-v4-pro", PriceUsd { input_per_million: 0.55, output_per_million: 2.20 }),
    ("deepseek-v4-flash", PriceUsd { input_per_million: 0.14, output_per_million: 0.28 }),
    ("deepseek", PriceUsd { input_per_million: 0.27, output_per_million: 1.10 }),
    // ---- xAI ----
    ("grok-3-mini", PriceUsd { input_per_million: 0.30, output_per_million: 0.50 }),
    ("grok-3", PriceUsd { input_per_million: 3.0, output_per_million: 15.0 }),
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn longest_match_wins() {
        // Versioned IDs should still resolve to the right tier.
        let p = lookup("claude-opus-4-6-20251215").expect("opus matches");
        assert!((p.input_per_million - 15.0).abs() < 0.01);
    }

    #[test]
    fn case_insensitive() {
        assert!(lookup("DeepSeek-V4-Pro").is_some());
        assert!(lookup("GPT-4O").is_some());
    }

    #[test]
    fn unknown_model_returns_none() {
        assert!(lookup("bogus-model-7000").is_none());
    }

    #[test]
    fn estimate_cost_uses_per_million_scaling() {
        // 1M input + 1M output @ deepseek-v4-flash = 0.14 + 0.28 = $0.42.
        let cost = estimate_cost("deepseek-v4-flash", 1_000_000, 1_000_000).unwrap();
        assert!((cost - 0.42).abs() < 0.001, "got {cost}");
    }
}

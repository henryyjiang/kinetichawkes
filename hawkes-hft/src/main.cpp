#include "sim/Simulator.hpp"
#include <nlohmann/json.hpp>
#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <string>

static bool load_config(const std::string& path, Simulator& sim) {
    std::ifstream f(path);
    if (!f) {
        fprintf(stderr, "ERROR: cannot open config %s\n", path.c_str());
        return false;
    }
    nlohmann::json cfg = nlohmann::json::parse(f);

    auto get = [&](const char* section, const char* key) {
        return cfg.at(section).at(key).get<double>();
    };

    auto& k = cfg.at("kinetic");
    sim.load_params(
        get("buy",    "mu"), get("buy",    "alpha"), get("buy",    "beta"),
        get("sell",   "mu"), get("sell",   "alpha"), get("sell",   "beta"),
        get("cancel", "mu"), get("cancel", "alpha"), get("cancel", "beta"),
        k.value("beta0", -5.5), k.value("beta1", -4.0),
        k.value("beta2",  0.6), k.value("beta3",  0.15)
    );

    // Optional strategy overrides — all have sensible defaults already set on the structs.
    if (cfg.contains("strategy")) {
        auto& s = cfg.at("strategy");
        if (s.contains("gamma_as"))          sim.inv.gamma_as         = s.at("gamma_as").get<double>();
        if (s.contains("base_spread"))       sim.inv.base_spread      = s.at("base_spread").get<int64_t>();
        if (s.contains("k_hawkes"))          sim.inv.k_hawkes         = s.at("k_hawkes").get<double>();
        if (s.contains("max_half_spread"))   sim.inv.max_half_spread  = s.at("max_half_spread").get<int64_t>();
        if (s.contains("max_inventory")) {
            int32_t mi = s.at("max_inventory").get<int32_t>();
            sim.inv.max_inventory         = mi;
            sim.risk_gate.max_inventory   = mi;   // keep in sync
        }
        if (s.contains("inv_one_side_frac")) sim.mm.inv_one_side_frac = s.at("inv_one_side_frac").get<double>();
        if (s.contains("min_fill_prob"))     sim.mm.min_fill_prob     = s.at("min_fill_prob").get<double>();
        if (s.contains("default_size"))      sim.mm.default_size      = s.at("default_size").get<int32_t>();
    }
    return true;
}

int main(int argc, char* argv[]) {
    if (argc < 3) {
        fprintf(stderr, "Usage: %s <path-to.dbn> <path-to-config.json> [log_interval]\n", argv[0]);
        return 1;
    }

    std::string dbn_path    = argv[1];
    std::string config_path = argv[2];
    int         log_interval = (argc >= 4) ? std::atoi(argv[3]) : 10'000;
    if (log_interval <= 0) {
        fprintf(stderr, "ERROR: log_interval must be > 0\n");
        return 1;
    }

    fprintf(stderr, "hawkes-hft replay\n");
    fprintf(stderr, "  DBN    : %s\n", dbn_path.c_str());
    fprintf(stderr, "  Config : %s\n", config_path.c_str());
    fprintf(stderr, "  Interval: every %d session events\n\n", log_interval);

    Logger    lg{stdout};
    Simulator sim{lg};
    sim.log_interval = log_interval;

    if (!load_config(config_path, sim))
        return 1;

    // session_close_ns is now computed per trading day inside Simulator::maybe_advance_day
    // so there is no hardcoded date here.

    sim.run(dbn_path);
    return 0;
}

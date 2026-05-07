#pragma once
#include <cstdio>
#include <cstdint>

struct Logger {
    FILE* out;

    explicit Logger(FILE* f = stdout) : out(f) {}

    void book(int64_t t, int64_t mid, int64_t spread, int64_t bid_qty, int64_t ask_qty) {
        fprintf(out,
            "{\"t\":%lld,\"type\":\"book\","
            "\"mid\":%lld,\"spread\":%lld,\"bid_qty\":%lld,\"ask_qty\":%lld}\n",
            (long long)t, (long long)mid, (long long)spread,
            (long long)bid_qty, (long long)ask_qty);
    }

    void hawkes(int64_t t, double lam_buy, double lam_sell, double lam_cancel, double imbalance) {
        fprintf(out,
            "{\"t\":%lld,\"type\":\"hawkes\","
            "\"lam_buy\":%.4f,\"lam_sell\":%.4f,\"lam_cancel\":%.4f,\"imbalance\":%.4f}\n",
            (long long)t, lam_buy, lam_sell, lam_cancel, imbalance);
    }

    void quote(int64_t t, int64_t bid, int64_t ask, int32_t size) {
        fprintf(out,
            "{\"t\":%lld,\"type\":\"quote\",\"bid\":%lld,\"ask\":%lld,\"size\":%d}\n",
            (long long)t, (long long)bid, (long long)ask, size);
    }

    void fill(int64_t t, int8_t side, int64_t price, int32_t size, int64_t pnl_delta) {
        fprintf(out,
            "{\"t\":%lld,\"type\":\"fill\",\"side\":\"%s\","
            "\"price\":%lld,\"size\":%d,\"pnl_delta\":%lld}\n",
            (long long)t, side == 1 ? "bid" : "ask",
            (long long)price, size, (long long)pnl_delta);
    }

    void pnl(int64_t t, int64_t realized, int64_t unrealized, int32_t inventory) {
        fprintf(out,
            "{\"t\":%lld,\"type\":\"pnl\","
            "\"realized\":%lld,\"unrealized\":%lld,\"inventory\":%d}\n",
            (long long)t, (long long)realized, (long long)unrealized, inventory);
    }

    void halt(int64_t t, const char* reason) {
        fprintf(out,
            "{\"t\":%lld,\"type\":\"halt\",\"reason\":\"%s\"}\n",
            (long long)t, reason);
    }
};

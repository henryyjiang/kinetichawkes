#pragma once
#include <cstdint>

// Internal order event types — no databento dependency so these can be
// included by the book, models, tests, and strategy code directly.
enum class EventType : uint8_t {
    Add, Cancel, Modify, Trade, Fill, Clear, Halt, Unknown
};

struct OrderEvent {
    int64_t   timestamp_ns;
    EventType type;
    uint64_t  order_id;
    int32_t   size;
    int64_t   price;
    int8_t    side;    // 1=bid, -1=ask, 0=unknown
};

// F.side='A' → passive ask filled → market buy (0); F.side='B' → market sell (1)
inline int hawkes_event_type(char action, char side) {
    if (action == 'F')
        return (side == 'A') ? 0 : 1;
    if (action == 'C')
        return 2;
    return -1;
}

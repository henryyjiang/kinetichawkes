#pragma once
#include "feed/OrderEvent.hpp"
#include <databento/record.hpp>

struct DatabentoAdapter {
    OrderEvent convert(const databento::MboMsg& msg) const {
        const char action = static_cast<char>(msg.action);
        const char side   = static_cast<char>(msg.side);

        EventType type = EventType::Unknown;
        switch (action) {
            case 'A': type = EventType::Add;    break;
            case 'C': type = EventType::Cancel; break;
            case 'M': type = EventType::Modify; break;
            case 'T': type = EventType::Trade;  break;
            case 'F': type = EventType::Fill;   break;
            case 'R': type = EventType::Clear;  break;
            default:  break;
        }

        int8_t side_int = 0;
        if (side == 'B') side_int =  1;
        if (side == 'A') side_int = -1;

        return OrderEvent{
            .timestamp_ns = static_cast<int64_t>(msg.hd.ts_event.time_since_epoch().count()),
            .type         = type,
            .order_id     = msg.order_id,
            .size         = static_cast<int32_t>(msg.size),
            .price        = msg.price,
            .side         = side_int,
        };
    }
};

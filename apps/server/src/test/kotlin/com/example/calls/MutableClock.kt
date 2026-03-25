package com.example.calls

import java.time.Clock
import java.time.Instant
import java.time.ZoneId

class MutableClock(
    private var currentInstant: Instant,
    private var currentZone: ZoneId = ZoneId.of("UTC"),
) : Clock() {
    override fun getZone(): ZoneId = currentZone

    override fun withZone(zone: ZoneId): Clock = MutableClock(currentInstant, zone)

    override fun instant(): Instant = currentInstant

    fun advanceSeconds(seconds: Long) {
        currentInstant = currentInstant.plusSeconds(seconds)
    }
}


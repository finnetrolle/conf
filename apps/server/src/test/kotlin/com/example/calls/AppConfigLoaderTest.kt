package com.example.calls

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

class AppConfigLoaderTest {
    @Test
    fun `reads legacy static turn credentials from environment`() {
        val config = AppConfigLoader.fromEnvironment(
            mapOf(
                "TURN_USERNAME" to "legacy-user",
                "TURN_PASSWORD" to "legacy-password",
            ),
        )

        assertEquals("legacy-user", config.turnUsername)
        assertEquals("legacy-password", config.turnPassword)
        assertNull(config.turnAuthSecret)
    }
}

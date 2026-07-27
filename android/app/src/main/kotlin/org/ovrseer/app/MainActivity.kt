package org.ovrseer.app

import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import android.provider.Settings
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import java.io.ByteArrayOutputStream
import kotlin.concurrent.thread

class MainActivity : FlutterActivity() {
    private val notificationSettingsChannelName = "dev.rnm.overseer/notification-settings"
    private val attachmentClipboardChannelName = "dev.rnm.overseer/attachment-clipboard"

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(
            flutterEngine.dartExecutor.binaryMessenger,
            notificationSettingsChannelName,
        ).setMethodCallHandler { call, result ->
            if (call.method != "open") {
                result.notImplemented()
                return@setMethodCallHandler
            }
            try {
                val intent = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).apply {
                        putExtra(Settings.EXTRA_APP_PACKAGE, packageName)
                    }
                } else {
                    Intent(
                        Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                        Uri.parse("package:$packageName"),
                    )
                }
                startActivity(intent)
                result.success(true)
            } catch (error: Throwable) {
                result.error("OPEN_NOTIFICATION_SETTINGS_FAILED", error.message, null)
            }
        }
        MethodChannel(
            flutterEngine.dartExecutor.binaryMessenger,
            attachmentClipboardChannelName,
        ).setMethodCallHandler { call, result ->
            thread(name = "overseer-clipboard-reader") {
                try {
                    val payload = when (call.method) {
                        "read" -> readClipboardAttachments(
                            call.argument<Int>("maxFiles") ?: 10,
                            call.argument<Int>("maxBytes") ?: 25 * 1024 * 1024,
                        )
                        "readUri" -> {
                            val rawUri = call.argument<String>("uri")
                                ?: throw IllegalArgumentException("Missing clipboard URI")
                            readInsertedAttachment(
                                Uri.parse(rawUri),
                                call.argument<String>("mimeType"),
                                call.argument<Int>("maxBytes") ?: 25 * 1024 * 1024,
                            )
                        }
                        else -> {
                            runOnUiThread { result.notImplemented() }
                            return@thread
                        }
                    }
                    runOnUiThread { result.success(payload) }
                } catch (error: Throwable) {
                    runOnUiThread {
                        result.error("CLIPBOARD_READ_FAILED", error.message, null)
                    }
                }
            }
        }
    }

    private fun readClipboardAttachments(
        maxFiles: Int,
        maxBytes: Int,
    ): Map<String, Any> {
        val manager = getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        val clip = manager.primaryClip
            ?: return mapOf(
                "attachments" to emptyList<Map<String, Any>>(),
                "skippedTooLarge" to 0,
                "skippedForLimit" to 0,
            )
        val attachments = mutableListOf<Map<String, Any>>()
        var skippedTooLarge = 0
        var skippedForLimit = 0
        for (index in 0 until clip.itemCount) {
            val uri = clip.getItemAt(index).uri ?: continue
            val metadata = clipboardMetadata(uri)
            if (metadata?.second?.let { it > maxBytes } == true) {
                skippedTooLarge++
                continue
            }
            if (attachments.size >= maxFiles) {
                skippedForLimit++
                continue
            }
            val bytes = readClipboardUri(uri, maxBytes)
            if (bytes == null) {
                skippedTooLarge++
                continue
            }
            val mimeType = contentResolver.getType(uri)
            attachments.add(
                mapOf(
                    "name" to (
                        metadata?.first
                            ?: uri.lastPathSegment
                            ?: "pasted-file"
                    ),
                    "type" to if (mimeType?.startsWith("image/") == true) {
                        "image"
                    } else {
                        "file"
                    },
                    "bytes" to bytes,
                ),
            )
        }
        return mapOf(
            "attachments" to attachments,
            "skippedTooLarge" to skippedTooLarge,
            "skippedForLimit" to skippedForLimit,
        )
    }

    private fun readInsertedAttachment(
        uri: Uri,
        providedMimeType: String?,
        maxBytes: Int,
    ): Map<String, Any> {
        val metadata = clipboardMetadata(uri)
        if (metadata?.second?.let { it > maxBytes } == true) {
            return mapOf(
                "attachments" to emptyList<Map<String, Any>>(),
                "skippedTooLarge" to 1,
                "skippedForLimit" to 0,
            )
        }
        val bytes = readClipboardUri(uri, maxBytes)
            ?: return mapOf(
                "attachments" to emptyList<Map<String, Any>>(),
                "skippedTooLarge" to 1,
                "skippedForLimit" to 0,
            )
        val mimeType = providedMimeType ?: contentResolver.getType(uri)
        return mapOf(
            "attachments" to listOf(
                mapOf(
                    "name" to (
                        metadata?.first
                            ?: uri.lastPathSegment
                            ?: "pasted-file"
                    ),
                    "type" to if (mimeType?.startsWith("image/") == true) {
                        "image"
                    } else {
                        "file"
                    },
                    "bytes" to bytes,
                ),
            ),
            "skippedTooLarge" to 0,
            "skippedForLimit" to 0,
        )
    }

    private fun clipboardMetadata(uri: Uri): Pair<String?, Long?>? {
        return contentResolver.query(
            uri,
            arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE),
            null,
            null,
            null,
        )?.use { cursor ->
            if (!cursor.moveToFirst()) {
                null
            } else {
                val nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                val sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE)
                Pair(
                    if (nameIndex >= 0) cursor.getString(nameIndex) else null,
                    if (sizeIndex >= 0 && !cursor.isNull(sizeIndex)) {
                        cursor.getLong(sizeIndex)
                    } else {
                        null
                    },
                )
            }
        }
    }

    private fun readClipboardUri(uri: Uri, maxBytes: Int): ByteArray? {
        val input = contentResolver.openInputStream(uri)
            ?: throw IllegalStateException("Clipboard content could not be opened")
        return input.use {
            val output = ByteArrayOutputStream()
            val buffer = ByteArray(64 * 1024)
            var total = 0
            while (true) {
                val count = it.read(buffer)
                if (count < 0) break
                total += count
                if (total > maxBytes) return null
                output.write(buffer, 0, count)
            }
            output.toByteArray()
        }
    }

}

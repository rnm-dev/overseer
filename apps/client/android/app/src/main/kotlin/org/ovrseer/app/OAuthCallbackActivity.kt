package org.ovrseer.app

import android.app.Activity
import android.app.ActivityManager
import android.content.Intent
import android.os.Bundle
import com.linusu.flutter_web_auth_2.AuthenticationManagementActivity
import com.linusu.flutter_web_auth_2.FlutterWebAuth2Plugin

class OAuthCallbackActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val callbackUrl = intent?.data
        val callbackScheme = callbackUrl?.scheme
        if (callbackUrl != null && callbackScheme != null) {
            FlutterWebAuth2Plugin.callbacks
                .remove(callbackScheme)
                ?.success(callbackUrl.toString())
        }

        returnToOverseer()
    }

    private fun returnToOverseer() {
        val activityManager = getSystemService(ACTIVITY_SERVICE) as ActivityManager
        val overseerTask = activityManager.appTasks.firstOrNull { task ->
            task.taskInfo.baseIntent.component?.className == MainActivity::class.java.name
        }

        if (overseerTask != null) {
            val responseIntent =
                AuthenticationManagementActivity.createResponseHandlingIntent(this)
            overseerTask.startActivity(this, responseIntent, null)
        } else {
            startActivity(
                Intent(this, MainActivity::class.java).apply {
                    flags =
                        Intent.FLAG_ACTIVITY_NEW_TASK or
                            Intent.FLAG_ACTIVITY_CLEAR_TOP or
                            Intent.FLAG_ACTIVITY_SINGLE_TOP
                },
            )
        }

        finish()
    }
}

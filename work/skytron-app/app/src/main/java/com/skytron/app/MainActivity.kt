package com.skytron.app

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Environment
import android.provider.MediaStore
import android.provider.Settings
import android.webkit.*
import androidx.webkit.WebViewAssetLoader
import android.util.Log
import android.widget.FrameLayout
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import androidx.core.content.FileProvider
import com.skytron.app.native.NativeBridge
import java.io.File
import java.text.SimpleDateFormat
import java.util.*

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private var photoUri: Uri? = null
    private var fileCallback: ValueCallback<Array<Uri>>? = null
    private var permissionCallback: ((Boolean) -> Unit)? = null

    private val requiredPermissions = arrayOf(
        Manifest.permission.CAMERA,
        Manifest.permission.RECORD_AUDIO,
        Manifest.permission.ACCESS_FINE_LOCATION,
        Manifest.permission.ACCESS_COARSE_LOCATION,
    )

    private val storagePermissions = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        arrayOf(
            Manifest.permission.READ_MEDIA_IMAGES,
            Manifest.permission.READ_MEDIA_VIDEO,
            Manifest.permission.READ_MEDIA_AUDIO,
        )
    } else {
        arrayOf(
            Manifest.permission.READ_EXTERNAL_STORAGE,
            Manifest.permission.WRITE_EXTERNAL_STORAGE,
        )
    }

    private var bridge: NativeBridge? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val container = FrameLayout(this)
        webView = WebView(this).apply {
            layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT
            )
        }
        container.addView(webView)
        setContentView(container)

        setupWebView()
        requestAllPermissions()
        webView.loadUrl("https://appassets.androidplatform.net/index.html")

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) {
                    webView.goBack()
                } else {
                    isEnabled = false
                    onBackPressedDispatcher.onBackPressed()
                }
            }
        })
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView() {
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowContentAccess = true
            databaseEnabled = true
            cacheMode = WebSettings.LOAD_CACHE_ELSE_NETWORK
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            mediaPlaybackRequiresUserGesture = false
            setSupportMultipleWindows(false)
            loadWithOverviewMode = true
            useWideViewPort = true
            builtInZoomControls = false
            displayZoomControls = false
        }

        webView.setInitialScale(100)

        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(
                view: WebView, request: WebResourceRequest
            ): WebResourceResponse? {
                return assetLoader.shouldInterceptRequest(request.url)
            }

            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                val url = request.url.toString()
                if (url.startsWith("http://") || url.startsWith("https://")) {
                    if (!url.startsWith("https://appassets.androidplatform.net")) {
                        startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
                        return true
                    }
                }
                return false
            }

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) {
                if (request.isForMainFrame) {
                    view.loadData(
                        OFFLINE_HTML,
                        "text/html", "UTF-8"
                    )
                }
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(message: ConsoleMessage): Boolean {
                Log.d("WebView", "${message.message()} -- line ${message.lineNumber()} of ${message.sourceId()}")
                return true
            }

            override fun onShowFileChooser(
                webView: WebView,
                filePathCallback: ValueCallback<Array<Uri>>,
                fileChooserParams: FileChooserParams
            ): Boolean {
                fileCallback?.onReceiveValue(null)
                fileCallback = filePathCallback
                openFilePicker()
                return true
            }
        }

        bridge = NativeBridge(this, webView)
        webView.addJavascriptInterface(bridge!!, "AndroidBridge")
    }

    fun openFilePicker() {
        val intent = Intent(Intent.ACTION_GET_CONTENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "*/*"
            putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
        }
        startActivityForResult(Intent.createChooser(intent, "Select File"), FILE_PICKER_CODE)
    }

    fun takePicture() {
        val photoFile = File.createTempFile(
            "IMG_${SimpleDateFormat("yyyyMMdd_HHmmss", Locale.US).format(Date())}",
            ".jpg",
            cacheDir
        )
        photoUri = FileProvider.getUriForFile(this, "${packageName}.fileprovider", photoFile)
        val intent = Intent(MediaStore.ACTION_IMAGE_CAPTURE).apply {
            putExtra(MediaStore.EXTRA_OUTPUT, photoUri)
        }
        startActivityForResult(intent, CAMERA_REQUEST_CODE)
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        when (requestCode) {
            CAMERA_REQUEST_CODE -> {
                if (resultCode == Activity.RESULT_OK) {
                    val bridge = webView.evaluateJavascript("window.AndroidBridge", null)
                    webView.post {
                        webView.evaluateJavascript(
                            "window._photoCallback && window._photoCallback('${photoUri?.toString()}')",
                            null
                        )
                    }
                } else {
                    webView.post {
                        webView.evaluateJavascript(
                            "window._photoCallback && window._photoCallback('')",
                            null
                        )
                    }
                }
            }
            FILE_PICKER_CODE -> {
                val result = if (resultCode == Activity.RESULT_OK) {
                    val clipData = data?.clipData
                    if (clipData != null) {
                        Array(clipData.itemCount) { clipData.getItemAt(it).uri }
                    } else {
                        data?.data?.let { arrayOf(it) }
                    }
                } else null
                
                if (fileCallback != null) {
                    fileCallback?.onReceiveValue(result)
                    fileCallback = null
                } else {
                    val uris = result?.joinToString(",") { it.toString() } ?: ""
                    webView.post {
                        webView.evaluateJavascript(
                            "window._fileCallback && window._fileCallback('$uris')",
                            null
                        )
                    }
                }
            }
            PERMISSION_REQUEST_CODE -> {
                val allGranted = requiredPermissions.all {
                    ContextCompat.checkSelfPermission(this, it) == PackageManager.PERMISSION_GRANTED
                }
                permissionCallback?.invoke(allGranted)
                permissionCallback = null
            }
        }
    }

    private fun requestAllPermissions() {
        val allPermissions = requiredPermissions + storagePermissions
        val notGranted = allPermissions.filter {
            ContextCompat.checkSelfPermission(this, it) != PackageManager.PERMISSION_GRANTED
        }
        if (notGranted.isNotEmpty()) {
            ActivityCompat.requestPermissions(this, notGranted.toTypedArray(), PERMISSION_REQUEST_CODE)
        }
    }

    fun requestPermission(permission: String, callback: (Boolean) -> Unit) {
        if (ContextCompat.checkSelfPermission(this, permission) == PackageManager.PERMISSION_GRANTED) {
            callback(true)
            return
        }
        permissionCallback = callback
        ActivityCompat.requestPermissions(this, arrayOf(permission), PERMISSION_REQUEST_CODE)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        val allGranted = grantResults.all { it == PackageManager.PERMISSION_GRANTED }
        permissionCallback?.invoke(allGranted)
        permissionCallback = null
    }

    override fun onDestroy() {
        bridge?.cleanup()
        webView.destroy()
        super.onDestroy()
    }

    companion object {
        private const val CAMERA_REQUEST_CODE = 1001
        private const val FILE_PICKER_CODE = 1002
        private const val PERMISSION_REQUEST_CODE = 1003

        private const val OFFLINE_HTML = """
        <!DOCTYPE html>
        <html>
        <head>
            <meta name="viewport" content="width=device-width, initial-scale=1.0">
            <style>
                body { margin:0; padding:20px; font-family:system-ui; background:#0a0a0f; color:#e4e4e7; display:flex; flex-direction:column; align-items:center; justify-content:center; min-height:100vh; }
                h1 { font-size:24px; margin-bottom:8px; }
                p { color:#a1a1aa; text-align:center; }
            </style>
        </head>
        <body>
            <h1>Skytron</h1>
            <p>You're offline. Reconnect to continue.</p>
        </body>
        </html>
        """
    }
}

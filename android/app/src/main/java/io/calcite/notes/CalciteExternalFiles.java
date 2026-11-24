package io.calcite.notes;

import android.app.Activity;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.Process;
import android.os.storage.StorageManager;
import android.os.storage.StorageVolume;
import android.provider.OpenableColumns;
import androidx.core.content.IntentCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

@CapacitorPlugin(name = "CalciteExternalFiles")
public class CalciteExternalFiles extends Plugin {
    private final ThreadPoolExecutor reader =
        new ThreadPoolExecutor(1, 1, 0, TimeUnit.SECONDS, new LinkedBlockingQueue<>(8));
    private final PendingExternalFiles<JSObject> pending = new PendingExternalFiles<>(8);
    private volatile boolean overflow;
    private volatile boolean destroyed;

    @Override
    protected void handleOnNewIntent(Intent intent) {
        String action = intent.getAction();
        if (!Intent.ACTION_VIEW.equals(action) && !Intent.ACTION_SEND.equals(action)) return;
        // Capacitor calls this for the launch Intent and for later deliveries.
        if (destroyed) return;
        Uri uri;
        String sharedText = null;
        String sharedSubject = null;
        try {
            uri = Intent.ACTION_VIEW.equals(action) ? intent.getData()
                : IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri.class);
            ClipData clip = intent.getClipData();
            if (uri == null && clip != null && clip.getItemCount() == 1) uri = clip.getItemAt(0).getUri();
            if (uri == null && Intent.ACTION_SEND.equals(action)) {
                CharSequence extra = intent.getCharSequenceExtra(Intent.EXTRA_TEXT);
                if (extra != null) sharedText = extra.toString();
                if ((sharedText == null || sharedText.isEmpty()) && clip != null && clip.getItemCount() >= 1) {
                    CharSequence clipText = clip.getItemAt(0).getText();
                    if (clipText != null) sharedText = clipText.toString();
                }
                CharSequence subject = intent.getCharSequenceExtra(Intent.EXTRA_SUBJECT);
                if (subject != null) sharedSubject = subject.toString();
            }
        } catch (RuntimeException error) {
            enqueueError(R.string.external_unrecognized);
            return;
        }
        if (uri == null && sharedText == null) {
            enqueueError(R.string.external_select);
            return;
        }
        Uri file = uri;
        String text = sharedText;
        String subject = sharedSubject;
        try {
            reader.execute(() -> {
                JSObject result = file != null ? readFile(file) : readSharedText(subject, text);
                postPublish(result);
            });
        } catch (RejectedExecutionException error) {
            overflow = true;
            notifyListeners("externalFileAvailable", new JSObject());
        }
    }

    private void postPublish(JSObject result) {
        if (destroyed) return;
        Activity activity = getActivity();
        if (activity != null && !activity.isFinishing() && !activity.isDestroyed()) {
            activity.runOnUiThread(() -> publish(result));
        }
    }

    private JSObject readSharedText(String subject, String raw) {
        try {
            String content = ExternalMarkdown.readText(
                new ByteArrayInputStream(raw.getBytes(StandardCharsets.UTF_8)));
            String candidate = subject != null && !subject.trim().isEmpty() ? subject.trim() : firstHeadingOrLine(content);
            String fallback = CalciteLanguage.text(getContext(), R.string.external_untitled);
            String cleaned = ExternalMarkdown.cleanName(candidate, fallback);
            if (!cleaned.matches("(?i).*\\.(?:md|markdown|mdown)$")) {
                cleaned = ExternalMarkdown.cleanName(cleaned + ".md", fallback);
            }
            return new JSObject().put("name", cleaned).put("text", content);
        } catch (ExternalMarkdown.InvalidDocument error) {
            return error(error.messageId);
        } catch (IOException | RuntimeException error) {
            return error(R.string.external_retry);
        }
    }

    private static String firstHeadingOrLine(String text) {
        for (String line : text.split("\\r?\\n")) {
            String trimmed = line.replaceFirst("^#+\\s*", "").trim();
            if (!trimmed.isEmpty()) return trimmed.length() > 64 ? trimmed.substring(0, 64) : trimmed;
        }
        return null;
    }

    private void enqueueError(int reason) {
        try {
            reader.execute(() -> postPublish(error(reason)));
        } catch (RejectedExecutionException error) {
            overflow = true;
            notifyListeners("externalFileAvailable", new JSObject());
        }
    }

    @PluginMethod
    public synchronized void consumePendingExternalFile(PluginCall call) {
        JSObject result = pending.poll();
        if (result == null && overflow) {
            overflow = false;
            result = error(R.string.external_queue_full);
        }
        int errorId = result == null ? 0 : result.getInteger("errorId", 0);
        if (errorId != 0) call.resolve(new JSObject().put("error", CalciteLanguage.text(getContext(), errorId)));
        else call.resolve(result == null ? new JSObject() : result);
    }

    private synchronized void publish(JSObject result) {
        if (destroyed) return;
        if (!pending.offer(result)) overflow = true;
        // The notification carries no content. The WebView pulls and clears the slot.
        notifyListeners("externalFileAvailable", new JSObject());
    }

    private JSObject readFile(Uri uri) {
        try {
            ContentResolver resolver = getContext().getContentResolver();
            String name;
            if ("content".equals(uri.getScheme())) {
                // Require the sender's URI grant even if the app can read its own provider.
                if (getContext().checkUriPermission(uri, Process.myPid(), Process.myUid(),
                        Intent.FLAG_GRANT_READ_URI_PERMISSION) != PackageManager.PERMISSION_GRANTED) {
                    return error(R.string.external_permission);
                }
                name = displayName(resolver, uri);
            } else if ("file".equals(uri.getScheme())) {
                File file = sharedFile(uri);
                uri = Uri.fromFile(file);
                name = file.getName();
            } else {
                return error(R.string.external_scheme);
            }
            try (InputStream input = resolver.openInputStream(uri)) {
                return new JSObject().put("name", ExternalMarkdown.cleanName(
                    name, CalciteLanguage.text(getContext(), R.string.external_untitled)))
                    .put("text", ExternalMarkdown.readText(input));
            }
        } catch (SecurityException | FileNotFoundException error) {
            return error(R.string.external_revoked);
        } catch (ExternalMarkdown.InvalidDocument error) {
            return error(error.messageId);
        } catch (IOException | RuntimeException error) {
            return error(R.string.external_retry);
        }
    }

    private String displayName(ContentResolver resolver, Uri uri) {
        try (Cursor cursor = resolver.query(uri, new String[] {OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            if (cursor == null || !cursor.moveToFirst()) return null;
            int name = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
            return name < 0 ? null : cursor.getString(name);
        } catch (IllegalArgumentException | UnsupportedOperationException ignored) {
            return null;
        }
    }

    @SuppressWarnings("deprecation")
    private File sharedFile(Uri uri) throws IOException {
        if (uri.getPath() == null || (uri.getAuthority() != null && !uri.getAuthority().isEmpty())) {
            throw new SecurityException();
        }
        File file = new File(uri.getPath()).getCanonicalFile();
        if (isPublicFile(file, Environment.getExternalStorageDirectory())) return file;
        if (Build.VERSION.SDK_INT >= 30) {
            StorageManager storage = getContext().getSystemService(StorageManager.class);
            if (storage != null) for (StorageVolume volume : storage.getStorageVolumes()) {
                if (isPublicFile(file, volume.getDirectory())) return file;
            }
        }
        throw new SecurityException();
    }

    private boolean isPublicFile(File file, File directory) throws IOException {
        if (directory == null) return false;
        String root = directory.getCanonicalPath() + File.separator;
        String path = file.getPath();
        // Android/ also holds apps' external private storage.
        return path.startsWith(root) && !path.substring(root.length()).regionMatches(true, 0, "Android/", 0, 8)
            && file.isFile();
    }

    @PluginMethod
    public void setLocale(PluginCall call) {
        CalciteLanguage.set(getContext(), call.getString("locale", ""));
        call.resolve();
    }

    private static JSObject error(int messageId) {
        return new JSObject().put("errorId", messageId);
    }

    @Override
    protected void handleOnDestroy() {
        destroyed = true;
        reader.shutdownNow();
    }
}

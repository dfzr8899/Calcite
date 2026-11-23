package io.calcite.notes;

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
import java.io.File;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.io.InputStream;
import java.util.concurrent.Future;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.ThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

@CapacitorPlugin(name = "CalciteExternalFiles")
public class CalciteExternalFiles extends Plugin {
    private final ThreadPoolExecutor reader =
        new ThreadPoolExecutor(1, 1, 0, TimeUnit.SECONDS, new LinkedBlockingQueue<>());
    private Future<?> reading;
    private JSObject pending;
    private int generation;

    @Override
    protected void handleOnNewIntent(Intent intent) {
        String action = intent.getAction();
        if (!Intent.ACTION_VIEW.equals(action) && !Intent.ACTION_SEND.equals(action)) return;
        // Capacitor calls this for the launch Intent and for later deliveries.
        int request = ++generation;
        if (reading != null) {
            reading.cancel(true);
            reader.purge();
        }
        synchronized (this) { pending = null; }
        Uri uri;
        try {
            uri = Intent.ACTION_VIEW.equals(action) ? intent.getData()
                : IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri.class);
            ClipData clip = intent.getClipData();
            if (uri == null && clip != null && clip.getItemCount() == 1) uri = clip.getItemAt(0).getUri();
        } catch (RuntimeException error) {
            publish(request, error("无法识别外部文件。"));
            return;
        }
        if (uri == null) {
            publish(request, error("请分享一个 Markdown 文件。"));
            return;
        }
        Uri file = uri;
        reading = reader.submit(() -> {
            JSObject result = readFile(file);
            getActivity().runOnUiThread(() -> publish(request, result));
        });
    }

    @PluginMethod
    public synchronized void consumePendingExternalFile(PluginCall call) {
        JSObject result = pending;
        pending = null;
        call.resolve(result == null ? new JSObject() : result);
    }

    private void publish(int request, JSObject result) {
        if (request != generation) return;
        synchronized (this) { pending = result; }
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
                    return error("没有权限读取外部文件，请从原应用重新打开或分享。");
                }
                name = displayName(resolver, uri);
            } else if ("file".equals(uri.getScheme())) {
                File file = sharedFile(uri);
                uri = Uri.fromFile(file);
                name = file.getName();
            } else {
                return error("请从系统文件管理器或分享菜单打开 Markdown 文件。");
            }
            try (InputStream input = resolver.openInputStream(uri)) {
                return new JSObject().put("name", ExternalMarkdown.cleanName(name))
                    .put("text", ExternalMarkdown.readText(input));
            }
        } catch (SecurityException | FileNotFoundException error) {
            return error("外部文件已不可读或没有读取权限，请从原应用重新分享。");
        } catch (ExternalMarkdown.InvalidDocument error) {
            return error(error.getMessage());
        } catch (IOException | RuntimeException error) {
            return error("无法读取外部文件，请从原应用重新分享。");
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

    private static JSObject error(String message) {
        return new JSObject().put("error", message == null ? "无法读取外部文件。" : message);
    }

    @Override
    protected void handleOnDestroy() {
        generation++;
        reader.shutdownNow();
        synchronized (this) { pending = null; }
    }
}

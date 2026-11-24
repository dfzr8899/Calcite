package io.calcite.notes;

import android.system.ErrnoException;
import android.system.Os;
import android.system.OsConstants;
import android.system.StructStat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileDescriptor;
import java.io.IOException;

@CapacitorPlugin(name = "CalciteAtomicFiles")
public class CalciteAtomicFiles extends Plugin {
    private File scoped(String path) throws IOException {
        if (path == null || !path.startsWith("/CalciteVaults/")) {
            throw new IOException("Invalid vault path");
        }
        File file = new File(getContext().getFilesDir().getCanonicalFile(), path.substring(1));
        if (!file.equals(file.getCanonicalFile())) {
            throw new IOException("Noncanonical vault path");
        }
        return file;
    }

    private void flush(File file) throws Exception {
        FileDescriptor handle = Os.open(file.getPath(), OsConstants.O_RDONLY | OsConstants.O_NOFOLLOW, 0);
        try {
            Os.fsync(handle);
        } finally {
            Os.close(handle);
        }
    }

    @PluginMethod
    public void flushDirectory(PluginCall call) {
        try {
            File directory = scoped(call.getString("path"));
            if (!directory.isDirectory()) throw new IOException("Invalid directory");
            flush(directory);
            call.resolve();
        } catch (Exception error) {
            call.reject("Directory sync failed", error);
        }
    }

    @PluginMethod
    public void sameFile(PluginCall call) {
        try {
            StructStat first = Os.lstat(scoped(call.getString("from")).getPath());
            StructStat second = Os.lstat(scoped(call.getString("to")).getPath());
            call.resolve(new JSObject().put("same", first.st_dev == second.st_dev && first.st_ino == second.st_ino));
        } catch (Exception error) {
            call.reject("File identity check failed", error);
        }
    }

    @PluginMethod
    public void rename(PluginCall call) {
        try {
            File from = scoped(call.getString("from"));
            File to = scoped(call.getString("to"));
            if (Boolean.TRUE.equals(call.getBoolean("temporary"))) {
                if (!from.getParentFile().equals(to.getParentFile()) || !from.getName().startsWith(".calcite-tmp-")) {
                    throw new IOException("Invalid temporary file");
                }
                flush(from);
            }
            if (Boolean.TRUE.equals(call.getBoolean("exclusive"))) {
                try {
                    Os.link(from.getPath(), to.getPath());
                } catch (ErrnoException error) {
                    if (error.errno == OsConstants.EEXIST) {
                        call.reject("Destination already exists", "EEXIST");
                        return;
                    }
                    throw error;
                }
                // The caller removes the temporary hard link after publishing.
            } else {
                Os.rename(from.getPath(), to.getPath());
            }
            flush(to.getParentFile());
            if (!from.getParentFile().equals(to.getParentFile())) flush(from.getParentFile());
            call.resolve();
        } catch (Exception error) {
            call.reject("Atomic rename failed", error);
        }
    }
}

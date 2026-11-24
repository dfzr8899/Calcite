package io.calcite.notes;

import android.os.Build;
import android.text.TextUtils;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URL;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import javax.net.ssl.HttpsURLConnection;

@CapacitorPlugin(name = "CalciteLegacyGitHttp")
public class CalciteLegacyGitHttp extends Plugin {
    private static final int MAX_BYTES = 96 * 1024 * 1024;

    @PluginMethod public void required(PluginCall call) {
        call.resolve(new JSObject().put("value", Build.VERSION.SDK_INT < Build.VERSION_CODES.O));
    }

    @PluginMethod public void request(PluginCall call) {
        HttpsURLConnection connection = null;
        try {
            String data = call.getString("data");
            URL url = new URL(call.getString("url", ""));
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O || !"https".equals(url.getProtocol())
                    || url.getUserInfo() != null || url.getRef() != null || !"POST".equals(call.getString("method"))
                    || data == null || data.length() > ((MAX_BYTES + 2L) / 3) * 4) {
                call.reject(CalciteLanguage.text(getContext(), R.string.legacy_git_invalid));
                return;
            }
            connection = (HttpsURLConnection) url.openConnection();
            connection.setInstanceFollowRedirects(false);
            connection.setRequestMethod("POST");
            connection.setConnectTimeout(12000);
            connection.setReadTimeout(40000);
            JSObject headers = call.getObject("headers", new JSObject());
            for (Iterator<String> keys = headers.keys(); keys.hasNext();) {
                String key = keys.next();
                connection.setRequestProperty(key, headers.getString(key));
            }
            byte[] body = Base64.decode(data, Base64.DEFAULT);
            connection.setDoOutput(true);
            connection.setFixedLengthStreamingMode(body.length);
            try (OutputStream stream = connection.getOutputStream()) {
                stream.write(body);
            }
            int status = connection.getResponseCode();
            JSObject resultHeaders = new JSObject();
            for (Map.Entry<String, List<String>> field : connection.getHeaderFields().entrySet()) {
                if (field.getKey() != null) resultHeaders.put(field.getKey(), TextUtils.join(", ", field.getValue()));
            }
            boolean ok = status >= 200 && status < 300;
            String payload = "";
            if (ok) {
                try (InputStream stream = connection.getInputStream(); ByteArrayOutputStream bytes = new ByteArrayOutputStream()) {
                    byte[] chunk = new byte[16384];
                    for (int count; (count = stream.read(chunk)) != -1;) {
                        if (bytes.size() + count > MAX_BYTES) throw new IOException("oversized response");
                        bytes.write(chunk, 0, count);
                    }
                    payload = Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP);
                }
            }
            call.resolve(new JSObject().put("status", status).put("url", url.toString())
                    .put("headers", resultHeaders).put("data", payload));
        } catch (Exception error) {
            call.reject(CalciteLanguage.text(getContext(), R.string.legacy_git_failed));
        } finally {
            if (connection != null) connection.disconnect();
        }
    }
}

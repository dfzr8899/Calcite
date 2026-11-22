package io.calcite.notes;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ContentResolver;
import android.content.Context;
import android.net.Uri;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;

@CapacitorPlugin(name = "CalciteRichClipboard")
public class CalciteRichClipboard extends Plugin {
    private static final int IMAGE_LIMIT = 32 * 1024 * 1024;
    private static boolean supportedType(String type) {
        if (type == null) return false;
        return switch (type) {
            case "image/png", "image/jpeg", "image/gif", "image/webp", "image/bmp", "image/avif", "image/svg+xml" -> true;
            default -> false;
        };
    }

    @PluginMethod
    public void readImage(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            ClipboardManager clipboard = (ClipboardManager) getContext().getSystemService(Context.CLIPBOARD_SERVICE);
            ClipData clip = clipboard == null ? null : clipboard.getPrimaryClip();
            Uri uri = clip == null || clip.getItemCount() == 0 ? null : clip.getItemAt(0).getUri();
            if (uri == null || !ContentResolver.SCHEME_CONTENT.equals(uri.getScheme())) {
                call.resolve();
                return;
            }
            getBridge().execute(() -> {
                ContentResolver resolver = getContext().getContentResolver();
                try {
                    String type = resolver.getType(uri);
                    if (!supportedType(type)) {
                        call.resolve();
                        return;
                    }
                    try (InputStream input = resolver.openInputStream(uri)) {
                        if (input == null) throw new java.io.IOException("Clipboard image unavailable");
                        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
                        byte[] buffer = new byte[24 * 1024];
                        for (int count; (count = input.read(buffer)) != -1;) {
                            if (bytes.size() + count > IMAGE_LIMIT) {
                                call.reject("剪贴板图片超过 32 MiB。");
                                return;
                            }
                            bytes.write(buffer, 0, count);
                        }
                        if (bytes.size() == 0) {
                            call.reject("剪贴板图片为空。");
                            return;
                        }
                        JSObject result = new JSObject();
                        result.put("type", type);
                        result.put("data", Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP));
                        call.resolve(result);
                    }
                } catch (Exception error) {
                    call.reject("无法读取剪贴板图片。", error);
                }
            });
        });
    }

    @PluginMethod
    public void write(PluginCall call) {
        String html = call.getString("html");
        String text = call.getString("text");
        if (html == null || text == null) {
            call.reject("缺少剪贴板内容。");
            return;
        }
        getActivity().runOnUiThread(() -> {
            ClipboardManager clipboard = (ClipboardManager) getContext().getSystemService(Context.CLIPBOARD_SERVICE);
            clipboard.setPrimaryClip(ClipData.newHtmlText("Calcite", text, html));
            call.resolve();
        });
    }
}

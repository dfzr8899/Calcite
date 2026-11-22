package io.calcite.notes;

import android.content.Context;
import android.os.Bundle;
import android.os.CancellationSignal;
import android.os.ParcelFileDescriptor;
import android.print.PageRange;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintManager;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "CalciteDocumentPrint")
public class CalciteDocumentPrint extends Plugin {
    private WebView printing;

    @PluginMethod
    public void pdf(PluginCall call) {
        String html = call.getString("html", "");
        String title = call.getString("title", "Calcite");
        if (html.isEmpty()) {
            call.reject("没有可打印的文档。");
            return;
        }
        getActivity().runOnUiThread(() -> {
            if (printing != null) {
                call.reject("请先关闭当前打印任务。");
                return;
            }
            PrintManager manager = (PrintManager) getActivity().getSystemService(Context.PRINT_SERVICE);
            if (manager == null) {
                call.reject("系统打印服务不可用。");
                return;
            }
            WebView view = new WebView(getActivity());
            printing = view;
            view.getSettings().setBlockNetworkLoads(true);
            view.getSettings().setAllowFileAccess(false);
            view.getSettings().setAllowContentAccess(false);
            view.getSettings().setDefaultTextEncodingName("UTF-8");
            view.setWebViewClient(new WebViewClient() {
                private boolean started;

                @Override
                public void onPageFinished(WebView webView, String url) {
                    if (started || printing != webView) return;
                    started = true;
                    try {
                        PrintDocumentAdapter adapter = webView.createPrintDocumentAdapter(title);
                        PrintAttributes.MediaSize size = switch (call.getString("paper", "A4")) {
                            case "A5" -> PrintAttributes.MediaSize.ISO_A5;
                            case "B5" -> PrintAttributes.MediaSize.ISO_B5;
                            case "Letter" -> PrintAttributes.MediaSize.NA_LETTER;
                            default -> PrintAttributes.MediaSize.ISO_A4;
                        };
                        if (Boolean.TRUE.equals(call.getBoolean("landscape", false))) size = size.asLandscape();
                        manager.print(title, releasingAdapter(adapter, webView),
                            new PrintAttributes.Builder().setMediaSize(size).build());
                        call.resolve();
                    } catch (RuntimeException error) {
                        release(webView);
                        call.reject("无法启动系统 PDF 打印。", error);
                    }
                }
            });
            view.loadDataWithBaseURL(null, html, "text/html", "UTF-8", null);
        });
    }

    private PrintDocumentAdapter releasingAdapter(PrintDocumentAdapter delegate, WebView view) {
        return new PrintDocumentAdapter() {
            @Override
            public void onStart() {
                delegate.onStart();
            }

            @Override
            public void onLayout(PrintAttributes previous, PrintAttributes next, CancellationSignal signal,
                                 LayoutResultCallback callback, Bundle extras) {
                delegate.onLayout(previous, next, signal, callback, extras);
            }

            @Override
            public void onWrite(PageRange[] pages, ParcelFileDescriptor file, CancellationSignal signal,
                                WriteResultCallback callback) {
                delegate.onWrite(pages, file, signal, callback);
            }

            @Override
            public void onFinish() {
                try {
                    delegate.onFinish();
                } finally {
                    release(view);
                }
            }
        };
    }

    private void release(WebView view) {
        if (printing == view) {
            printing = null;
            view.destroy();
        }
    }
}

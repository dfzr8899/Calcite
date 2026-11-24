package io.calcite.notes;

import android.content.Context;
import android.os.Bundle;
import android.os.CancellationSignal;
import android.os.Handler;
import android.os.Looper;
import android.os.ParcelFileDescriptor;
import android.print.PageRange;
import android.print.PrintAttributes;
import android.print.PrintDocumentAdapter;
import android.print.PrintManager;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "CalciteDocumentPrint")
public class CalciteDocumentPrint extends Plugin {
    private static final long LOAD_TIMEOUT_MS = 20_000L;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private WebView printing;
    private Runnable timeoutTask;

    @PluginMethod
    public void pdf(PluginCall call) {
        String html = call.getString("html", "");
        String title = call.getString("title", CalciteLanguage.text(getContext(), R.string.print_title));
        if (html.isEmpty()) {
            call.reject(CalciteLanguage.text(getContext(), R.string.no_printable));
            return;
        }
        if (getActivity() == null) {
            call.reject(CalciteLanguage.text(getContext(), R.string.print_unavailable));
            return;
        }
        getActivity().runOnUiThread(() -> {
            if (printing != null) {
                call.reject(CalciteLanguage.text(getContext(), R.string.print_busy));
                return;
            }
            PrintManager manager = (PrintManager) getActivity().getSystemService(Context.PRINT_SERVICE);
            if (manager == null) {
                call.reject(CalciteLanguage.text(getContext(), R.string.print_unavailable));
                return;
            }
            WebView view = new WebView(getActivity());
            printing = view;
            view.getSettings().setBlockNetworkLoads(true);
            view.getSettings().setAllowFileAccess(false);
            view.getSettings().setAllowContentAccess(false);
            view.getSettings().setDefaultTextEncodingName("UTF-8");
            final boolean[] settled = { false };
            Runnable failLoad = () -> {
                if (settled[0] || printing != view) return;
                settled[0] = true;
                release(view);
                call.reject(CalciteLanguage.text(getContext(), R.string.print_failed));
            };
            timeoutTask = failLoad;
            mainHandler.postDelayed(failLoad, LOAD_TIMEOUT_MS);
            view.setWebViewClient(new WebViewClient() {
                @Override
                public void onPageFinished(WebView webView, String url) {
                    if (settled[0] || printing != webView) return;
                    settled[0] = true;
                    clearTimeout();
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
                        call.reject(CalciteLanguage.text(getContext(), R.string.print_failed), error);
                    }
                }

                @Override
                public void onReceivedError(WebView webView, WebResourceRequest request, WebResourceError error) {
                    if (request == null || request.isForMainFrame()) failLoad.run();
                }

                @Override
                public boolean onRenderProcessGone(WebView webView, RenderProcessGoneDetail detail) {
                    failLoad.run();
                    return true;
                }
            });
            view.loadDataWithBaseURL(null, html, "text/html", "UTF-8", null);
        });
    }

    private void clearTimeout() {
        if (timeoutTask != null) {
            mainHandler.removeCallbacks(timeoutTask);
            timeoutTask = null;
        }
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
            clearTimeout();
            printing = null;
            view.destroy();
        }
    }

    @Override
    protected void handleOnDestroy() {
        clearTimeout();
        if (printing != null) {
            WebView active = printing;
            printing = null;
            active.destroy();
        }
    }
}

package io.calcite.notes;

import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import androidx.test.platform.app.InstrumentationRegistry;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class ExternalIntentFilterTest {
    @Test
    public void androidResolvesMarkdownViewAndShareToMainActivity() {
        for (String scheme : new String[] {"content://example.documents/", "file:///"}) {
            for (String mime : new String[] {"text/markdown", "text/x-markdown", "text/plain",
                    "application/octet-stream", "*/*", null}) {
                for (String name : new String[] {"v1.0.notes.md", "v1.0.notes.MD", "v1.0.notes.markdown"}) {
                    Intent view = new Intent(Intent.ACTION_VIEW).addCategory(Intent.CATEGORY_BROWSABLE);
                    assertResolves(view.setDataAndType(Uri.parse(scheme + "Download/" + name), mime));
                }
            }
        }
        assertResolves(new Intent(Intent.ACTION_VIEW).setDataAndType(
            Uri.parse("content://example.documents/483"), "application/octet-stream"));
        for (String mime : new String[] {"text/markdown", "text/x-markdown", "text/plain", "application/octet-stream"}) {
            assertResolves(new Intent(Intent.ACTION_SEND).setType(mime));
        }
    }

    private static void assertResolves(Intent intent) {
        Context context = InstrumentationRegistry.getInstrumentation().getTargetContext();
        intent.setPackage(context.getPackageName());
        assertTrue(intent.toString(), context.getPackageManager()
            .queryIntentActivities(intent, PackageManager.MATCH_DEFAULT_ONLY).stream()
            .anyMatch(activity -> MainActivity.class.getName().equals(activity.activityInfo.name)));
    }
}

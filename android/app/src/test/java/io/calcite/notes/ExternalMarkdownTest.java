package io.calcite.notes;

import static org.junit.Assert.*;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Path;
import java.util.HashSet;
import java.util.Set;
import javax.xml.parsers.DocumentBuilderFactory;
import org.junit.Test;
import org.w3c.dom.Element;

public class ExternalMarkdownTest {
    @Test
    public void cleansNamesWithoutLosingDotsOrExtensions() {
        assertEquals("v1.0.notes.md", ExternalMarkdown.cleanName("../private/v1.0.notes.md"));
        assertEquals("笔记_.MD", ExternalMarkdown.cleanName("C:\\Downloads\\..笔记?.MD"));
        assertEquals("_CON.markdown", ExternalMarkdown.cleanName("CON.markdown"));
        assertEquals("未命名文档.md", ExternalMarkdown.cleanName("folder/.."));
        assertEquals("未命名文档.md", ExternalMarkdown.cleanName(null));
        String longName = ExternalMarkdown.cleanName("笔".repeat(130) + ".markdown");
        assertEquals(100, longName.length());
        assertTrue(longName.endsWith(".markdown"));
    }

    @Test
    public void readsUtf8WithBomAndRejectsEmptyOrBinaryText() throws Exception {
        assertEquals("# 标题\r\n正文", read("\uFEFF# 标题\r\n正文".getBytes(StandardCharsets.UTF_8)));
        assertRejected(" \r\n\t".getBytes(StandardCharsets.UTF_8), "为空");
        assertRejected(new byte[] { '#', ' ', 0, 1 }, "二进制");
        assertRejected(new byte[] { (byte) 0xff, (byte) 0xfe }, "UTF-8");
    }

    @Test
    public void appliesSizeLimitEvenWithoutContentLength() throws Exception {
        assertRejected(new byte[ExternalMarkdown.MAX_BYTES + 1], "10 MiB");
        assertThrows(ExternalMarkdown.InvalidDocument.class, () -> ExternalMarkdown.readText((InputStream) null));
    }

    @Test
    public void manifestAdvertisesViewAndSendWithSingleTask() throws Exception {
        var manifest = DocumentBuilderFactory.newInstance().newDocumentBuilder()
            .parse(Path.of("src/main/AndroidManifest.xml").toFile());
        var activities = manifest.getElementsByTagName("activity");
        Element activity = null;
        for (int i = 0; i < activities.getLength(); i++) {
            Element row = (Element) activities.item(i);
            if (".MainActivity".equals(row.getAttribute("android:name"))) activity = row;
        }
        assertNotNull(activity);
        assertEquals("singleTask", activity.getAttribute("android:launchMode"));
        assertEquals("true", activity.getAttribute("android:exported"));
        var filters = activity.getElementsByTagName("intent-filter");
        boolean typedView = false, suffixView = false, untypedView = false, genericContent = false, send = false;
        for (int i = 0; i < filters.getLength(); i++) {
            var filter = (Element) filters.item(i);
            var actions = values(filter, "action", "android:name");
            var categories = values(filter, "category", "android:name");
            var mime = values(filter, "data", "android:mimeType");
            var schemes = values(filter, "data", "android:scheme");
            var suffixes = values(filter, "data", "android:pathSuffix");
            var patterns = values(filter, "data", "android:pathPattern");
            if (actions.contains("android.intent.action.VIEW")) {
                assertTrue(categories.containsAll(Set.of("android.intent.category.DEFAULT", "android.intent.category.BROWSABLE")));
                if (schemes.containsAll(Set.of("content", "file"))) {
                    typedView |= mime.containsAll(Set.of("text/markdown", "text/x-markdown", "text/plain"));
                    boolean suffix = values(filter, "data", "android:host").contains("*")
                        && suffixes.containsAll(Set.of(".md", ".markdown", ".MD"))
                        && patterns.contains(".*\\\\..*\\\\..*\\\\.md");
                    suffixView |= suffix && mime.contains("*/*");
                    untypedView |= suffix && mime.isEmpty();
                }
                genericContent |= schemes.equals(Set.of("content")) && mime.equals(Set.of("application/octet-stream"));
            }
            if (actions.contains("android.intent.action.SEND")) {
                assertTrue(categories.contains("android.intent.category.DEFAULT"));
                send |= mime.containsAll(Set.of("text/markdown", "text/x-markdown", "text/plain", "application/octet-stream"));
            }
        }
        assertTrue(typedView && suffixView && untypedView && genericContent && send);
    }

    private static Set<String> values(Element parent, String tag, String attribute) {
        Set<String> result = new HashSet<>();
        var nodes = parent.getElementsByTagName(tag);
        for (int i = 0; i < nodes.getLength(); i++) {
            String value = ((Element) nodes.item(i)).getAttribute(attribute);
            if (!value.isEmpty()) result.add(value);
        }
        return result;
    }

    private static String read(byte[] bytes) throws Exception {
        return ExternalMarkdown.readText(new ByteArrayInputStream(bytes));
    }

    private static void assertRejected(byte[] bytes, String reason) {
        assertTrue(assertThrows(ExternalMarkdown.InvalidDocument.class, () -> read(bytes)).getMessage().contains(reason));
    }
}

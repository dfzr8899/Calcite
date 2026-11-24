package io.calcite.notes;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.text.Normalizer;
import java.util.regex.Pattern;

final class ExternalMarkdown {
    static final int MAX_BYTES = 10 * 1024 * 1024;
    static final String DEFAULT_NAME = "Untitled Document.md";
    private static final Pattern DEVICE_NAME =
        Pattern.compile("(?i)^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\\.|$)");

    private ExternalMarkdown() {}

    static final class InvalidDocument extends IOException {
        final int messageId;
        InvalidDocument(int messageId) {
            this.messageId = messageId;
        }
    }

    static String cleanName(String raw) {
        return cleanName(raw, DEFAULT_NAME);
    }

    static String cleanName(String raw, String fallback) {
        if (raw == null) return fallback;
        String path = raw.replace('\\', '/');
        String name = Normalizer.normalize(path.substring(path.lastIndexOf('/') + 1), Normalizer.Form.NFC)
            .replaceAll("[<>:\"|?*\\p{Cntrl}\\p{Cf}]", "_")
            .replaceAll("^[.\\s]+|[.\\s]+$", "");
        if (name.isEmpty()) return fallback;
        if (DEVICE_NAME.matcher(name).find()) name = "_" + name;
        if (name.length() <= 100) return name;
        int dot = name.lastIndexOf('.');
        String suffix = dot > 0 && name.length() - dot <= 10 ? name.substring(dot) : "";
        int end = 100 - suffix.length();
        if (Character.isHighSurrogate(name.charAt(end - 1))) end--;
        return name.substring(0, end).replaceAll("[.\\s]+$", "") + suffix;
    }

    static String readText(InputStream input) throws IOException {
        if (input == null) throw new InvalidDocument(R.string.external_read);
        ByteArrayOutputStream bytes = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        int count;
        while ((count = input.read(buffer)) != -1) {
            if (Thread.currentThread().isInterrupted()) throw new IOException("Read interrupted.");
            if (count > MAX_BYTES - bytes.size()) throw new InvalidDocument(R.string.external_limit);
            bytes.write(buffer, 0, count);
        }
        String text;
        try {
            text = StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(bytes.toByteArray())).toString();
        } catch (CharacterCodingException error) {
            throw new InvalidDocument(R.string.external_utf8);
        }
        if (text.startsWith("\uFEFF")) text = text.substring(1);
        if (text.codePoints().anyMatch(point -> Character.isISOControl(point)
                && point != '\t' && point != '\n' && point != '\r' && point != '\f')) {
            throw new InvalidDocument(R.string.external_binary);
        }
        if (text.codePoints().allMatch(Character::isWhitespace)) throw new InvalidDocument(R.string.external_empty);
        return text;
    }
}

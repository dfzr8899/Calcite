package io.calcite.notes;

import java.util.ArrayDeque;

/** Holds completed launch/share results until the WebView consumes them. */
final class PendingExternalFiles<T> {
    private final ArrayDeque<T> files = new ArrayDeque<>();
    private final int limit;

    PendingExternalFiles(int limit) {
        this.limit = limit;
    }

    synchronized boolean offer(T value) {
        if (files.size() >= limit) return false;
        files.addLast(value);
        return true;
    }

    synchronized T poll() {
        return files.pollFirst();
    }
}

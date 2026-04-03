package machinum.streamer;

import lombok.Builder;

/**
 * Represents a non-fatal error during streaming.
 *
 * <p>When a stream source encounters a recoverable error (e.g., HTTP connection failure), it emits
 * a {@code StreamError} to the error handler instead of breaking the stream flow. The cursor at the
 * point of error is preserved for resume support.
 *
 * <p>See:
 *
 * <ul>
 *   <li>{@link Streamer#stream} — error-tolerant streaming
 *   <li><a href="../../../../docs/technical-design.md#5-error-handling">Technical Design §5</a>
 * </ul>
 */
@Builder
public record StreamError(
    ErrorType type, String message, Throwable cause, StreamCursor cursorAtError) {

  /** Classification of stream errors. */
  public enum ErrorType {
    /** HTTP/network failure — typically recoverable via retry. */
    CONNECTION,
    /** File read error. */
    IO,
    /** Content parsing/conversion error. */
    PARSE,
    /** Operation timed out — typically recoverable via retry. */
    TIMEOUT,
    /** Unclassified error. */
    UNKNOWN
  }

  /** Returns {@code true} if this error is likely recoverable by retrying. */
  public boolean isRecoverable() {
    return type == ErrorType.CONNECTION || type == ErrorType.TIMEOUT;
  }

  /** Creates a connection error with cursor position. */
  public static StreamError connection(String message, Throwable cause, StreamCursor cursor) {
    return new StreamError(ErrorType.CONNECTION, message, cause, cursor);
  }

  /** Creates an IO error with cursor position. */
  public static StreamError io(String message, Throwable cause, StreamCursor cursor) {
    return new StreamError(ErrorType.IO, message, cause, cursor);
  }

  /** Creates a timeout error with cursor position. */
  public static StreamError timeout(String message, Throwable cause, StreamCursor cursor) {
    return new StreamError(ErrorType.TIMEOUT, message, cause, cursor);
  }
}

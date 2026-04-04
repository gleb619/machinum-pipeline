package machinum.streamer;

import lombok.Builder;

@Builder
public record StreamError(
    ErrorType type, String message, Throwable cause, StreamCursor cursorAtError) {

  public enum ErrorType {
    CONNECTION,
    IO,
    PARSE,
    TIMEOUT,
    UNKNOWN
  }

  public boolean isRecoverable() {
    return type == ErrorType.CONNECTION || type == ErrorType.TIMEOUT;
  }

  public static StreamError connection(String message, Throwable cause, StreamCursor cursor) {
    return new StreamError(ErrorType.CONNECTION, message, cause, cursor);
  }

  public static StreamError io(String message, Throwable cause, StreamCursor cursor) {
    return new StreamError(ErrorType.IO, message, cause, cursor);
  }

  public static StreamError timeout(String message, Throwable cause, StreamCursor cursor) {
    return new StreamError(ErrorType.TIMEOUT, message, cause, cursor);
  }

  public static StreamError parse(String message, Throwable cause, StreamCursor cursor) {
    return new StreamError(ErrorType.PARSE, message, cause, cursor);
  }
}

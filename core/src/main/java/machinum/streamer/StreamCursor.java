package machinum.streamer;

import lombok.Builder;

@Builder
public record StreamCursor(int stateIndex, int itemOffset, int windowId) {

  public static StreamCursor initial() {
    return new StreamCursor(0, 0, 0);
  }

  public StreamCursor advance(int batchSize) {
    return new StreamCursor(stateIndex, itemOffset + batchSize, windowId + 1);
  }

  public StreamCursor forState(int stateIndex) {
    return new StreamCursor(stateIndex, itemOffset, windowId);
  }
}

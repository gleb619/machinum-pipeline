package machinum;

import io.jooby.Jooby;
import io.jooby.jetty.JettyServer;

public class HttpStreamer extends Jooby {

  {

    // Place jooby config here

  }

  public static void main(final String[] args) {
    runApp(args, new JettyServer(), HttpStreamer::new);
  }
}

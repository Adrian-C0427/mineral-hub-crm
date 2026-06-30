import { createApp } from "./app.js";
import { env } from "./config.js";

const app = createApp();
app.listen(env.PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`Mineral Hub API listening on :${env.PORT} (${env.NODE_ENV})`);
});

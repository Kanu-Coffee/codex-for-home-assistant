export default async ({ page }) => {
  const token = process.env.SUPERVISOR_TOKEN;
  if (!token) {
    return;
  }

  await page.addInitScript(({ accessToken }) => {
    if (
      window.location.origin !== "http://127.0.0.1:8099" &&
      window.location.origin !== "http://localhost:8099"
    ) {
      return;
    }

    const tokens = {
      hassUrl: window.location.origin,
      clientId: null,
      expires: Date.now() + 1e11,
      refresh_token: "",
      access_token: accessToken,
      expires_in: 1e11,
    };

    window.localStorage.setItem("hassTokens", JSON.stringify(tokens));
  }, { accessToken: token });
};

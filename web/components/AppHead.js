import Head from "next/head";

export function AppHead({ title = "Wanie", description = "AI messaging CRM for WhatsApp, Telegram, and external apps." }) {
  const fullTitle = title === "Wanie" ? title : `${title} | Wanie`;

  return (
    <Head>
      <title>{fullTitle}</title>
      <meta name="description" content={description} />
      <meta name="theme-color" content="#111b21" />
      <link rel="icon" href="/favicon.ico" />
    </Head>
  );
}

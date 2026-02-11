const AIRTABLE_API = "https://api.airtable.com/v0";

function formatAirtableError(status, text) {
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed.error === "string") {
      return `${parsed.error} (status ${status})`;
    }
    if (parsed.error && parsed.error.type) {
      return `${parsed.error.type} (status ${status})`;
    }
  } catch {
    // Ignore parse issues and fall back to raw text.
  }
  return `${text || "Unknown Airtable error"} (status ${status})`;
}

module.exports = async function () {
  const token = process.env.AIRTABLE_TOKEN;
  const baseId = process.env.AIRTABLE_BASE_ID;
  const tableName = process.env.AIRTABLE_TABLE_NAME || "Cats";
  const viewName = process.env.AIRTABLE_VIEW || "Approved";

  if (!token || !baseId) {
    return [];
  }

  const params = new URLSearchParams({
    view: viewName,
    pageSize: "100"
  });

  try {
    const response = await fetch(
      `${AIRTABLE_API}/${baseId}/${encodeURIComponent(tableName)}?${params.toString()}`,
      {
        headers: { Authorization: `Bearer ${token}` }
      }
    );

    if (!response.ok) {
      const text = await response.text();
      console.error(
        "Airtable read failed:",
        formatAirtableError(response.status, text),
        `(base=${baseId}, table=${tableName}, view=${viewName})`
      );
      return [];
    }

    const data = await response.json();
    return (data.records || [])
      .map((record) => ({
        id: record.id,
        createdTime: record.createdTime || "",
        name: record.fields["Cat Name"] || "Unnamed Cat",
        human: record.fields["Human Name"] || "Anonymous Developer",
        developerUrl: record.fields["Developer URL"] || "",
        photoUrl: record.fields["Photo URL"] || "",
        story: record.fields.Story || ""
      }))
      .sort((a, b) => Date.parse(b.createdTime) - Date.parse(a.createdTime))
      .filter((cat) => Boolean(cat.photoUrl));
  } catch (error) {
    console.error("Airtable read failed:", error);
    return [];
  }
};

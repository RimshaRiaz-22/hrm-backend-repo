
const generateEmailTemplate = ({
  title,
  message,
  recipientName,
  buttonText,
  buttonLink,
  details = [],
}) => {
  return `
    <html>
      <body style="font-family: Arial, sans-serif;">
        <h2>${title}</h2>

        <p>Hello ${recipientName},</p>

        <p>${message}</p>

        ${
          details.length
            ? `
            <table>
              ${details
                .map(
                  (item) => `
                    <tr>
                      <td><strong>${item.label}</strong></td>
                      <td>${item.value}</td>
                    </tr>
                  `
                )
                .join("")}
            </table>
          `
            : ""
        }

        ${
          buttonLink
            ? `<a href="${buttonLink}" style="padding:10px 20px;background:#2563eb;color:white;text-decoration:none;">
                ${buttonText}
              </a>`
            : ""
        }

        <p>Regards,<br>HR Team</p>
      </body>
    </html>
  `;
};

module.exports = generateEmailTemplate;
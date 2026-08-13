// Confirmation prompts for destructive admin forms (CSP forbids inline handlers).
document.addEventListener('submit', (event) => {
  const form = event.target.closest('form[data-confirm]');
  if (form && !window.confirm(form.dataset.confirm)) {
    event.preventDefault();
  }
});

// Invite links: click selects and copies.
document.addEventListener('click', (event) => {
  const input = event.target.closest('input[data-copy]');
  if (!input) return;
  input.select();
  if (navigator.clipboard) {
    navigator.clipboard.writeText(input.value).then(() => {
      const previous = input.title;
      input.title = 'Copied!';
      setTimeout(() => { input.title = previous; }, 1500);
    });
  }
});

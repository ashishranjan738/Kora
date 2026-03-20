import { notifications } from "@mantine/notifications";

/** Show a success toast notification */
export function showSuccess(message: string, title?: string) {
  notifications.show({
    title: title || "Success",
    message,
    color: "green",
    autoClose: 3000,
  });
}

/** Show an error toast notification */
export function showError(message: string, title?: string) {
  notifications.show({
    title: title || "Error",
    message,
    color: "red",
    autoClose: 5000,
  });
}

/** Show an info toast notification */
export function showInfo(message: string, title?: string) {
  notifications.show({
    title: title || "Info",
    message,
    color: "blue",
    autoClose: 3000,
  });
}

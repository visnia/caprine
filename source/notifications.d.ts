type NotificationCallback = {
	callbackName: keyof Notification;
	id: number;
	href?: string;
};

type NotificationReplyCallback = NotificationCallback & {
	previousConversation: number;
	reply: string;
};

import {DiscordModules, DOM, Injector as InjectorModule, LoggerModule, ReactTools, Settings, Webpack} from "@Holy";
import config from "./manifest.json";
import React, {useContext} from "react";
import styles from "./style.scss";

const {Flux, GuildStore, SelectedGuildStore, GuildMemberStore, ChannelStore, UserStore, RelationshipStore, Text} = DiscordModules;
const Logger = new LoggerModule(config.name);
const Injector = InjectorModule.create(config.name);
const UserContext = React.createContext(null);
const ColorConverter = Webpack.findByProps("isValidHex", "hex2int");

function useMemberColor(userId: string, guildId?: string) {
    return Flux.useStateFromStores([SelectedGuildStore, GuildMemberStore], () => {
        guildId ??= SelectedGuildStore.getGuildId();

        return GuildMemberStore.getMember(guildId, userId)?.colorString;
    });
}

export default class BetterRoleColors {
    flush: Array<Function> = [
        () => Injector.uninject()
    ];

    onStart(): void {
        this.patchMemberList();
        this.patchDiscordTag();
        this.patchAuditLog();
        this.patchGuildStickerCard();
        this.patchUserMention();
        this.patchVoiceUser();
        this.patchTypingUsers();

        DOM.injectCSS(config.name, styles);
        Settings.mount();

        this.flush.push(() => {
            DOM.clearCSS(config.name);
        });
    }

    async patchMemberList() {
        const MemberList = Webpack.findModule(e => e?.default?.toString().search(/members-.*ListNavigatorProvider/s) > -1);
        
        const MemberListSection = await new Promise<any>(resolve => {
            const unpatch = Injector.inject({
                module: MemberList,
                method: "default",
                after(_, __, ret) {
                    const channelMembers = ReactTools.findInReactTree(ret, e => e?.type?.displayName === "ChannelMembers")?.type;
                    if (!channelMembers) return;

                    try {
                        const instance = new channelMembers({groups: [], channel: {}});
                        const renderedSection = instance.renderSection({});
                        unpatch();
                        resolve(renderedSection.type);
                    } catch (error) {
                        Logger.error("Failed to grab nested MemberListSection:", error);
                    }
                }
            });
        });
        
        const originalType = MemberListSection.type;
        MemberListSection.type = function (props: {count: number, guildId: string, id: string, index: number, title: string, type: "GROUP"}) {
            const renderedSection = originalType.apply(this, arguments);

            try {
                const shouldColorize = Settings.useSettings(() => Settings.get("colorMemberList", true));
                const color = Flux.useStateFromStores([GuildStore], () => {
                    return GuildStore.getGuild(props.guildId)?.getRole(props.id)?.colorString;
                });
                if (!color) return renderedSection;

                const span = ReactTools.findInReactTree(renderedSection, e => e?.type === "span");
                if (!span) return renderedSection;

                if (shouldColorize) span.props.style = {color: color};
            } catch (error) {
                Logger.error("Failed to inject custom color:", error);
            }

            return renderedSection;
        };

        this.flush.push(() => {
            MemberListSection.type = originalType;
        });
    }

    async patchDiscordTag() {
        const [
            DiscordTag,
            NameTag
        ] = Webpack.bulk(
            Webpack.Filters.byDisplayName("DiscordTag", true),
            Webpack.Filters.byDisplayName("NameTag", true)
        );

        Injector.inject({
            module: DiscordTag,
            method: "default",
            after(_, [props], ret) {
                return (
                    <UserContext.Provider value={props.user}>
                        {ret}
                    </UserContext.Provider>
                );
            }
        });

        const originalMethod = NameTag.default;

        NameTag.default = function (props) {
            const user = useContext(UserContext);
            
            if (user) {
                try {
                    const shouldColorize = Settings.useSettings(() => Settings.get("colorNameTag", true));
                    const color = Flux.useStateFromStores([SelectedGuildStore, GuildMemberStore], () => {
                        return GuildMemberStore.getMember(SelectedGuildStore.getGuildId(), user.id)?.colorString;
                    });

                    if (shouldColorize) props.nameColor = color;
                } catch (error) {
                    Logger.error("Failed to colorize username:", error);
                }
            }
            
            const renderedName = originalMethod.apply(this, arguments);

            return renderedName;
        };

        this.flush.push(() => {
            NameTag.default = originalMethod;
        });
    }

    async patchAuditLog() {
        const [
            GuildSettingsAuditLogEntry,
            {userHook: userHookClass} = {} as any
        ] = Webpack.bulk(
            "GuildSettingsAuditLogEntry",
            ["userHook"]
        );
        
        const UserHook = (() => {
            try {
                const title = GuildSettingsAuditLogEntry.prototype.renderTitle.call({props: {log: {action: 1, options: {}}}});
                const UserHook = ReactTools.findInReactTree(title, e => e?.type?.displayName === "UserHook");
                if (!UserHook) return;

                return UserHook.type;
            } catch (error) {
                Logger.error("Failed to extract UserHook:", error);
            }
        })();

        function ColorizedAuditLogUsername({user, children}) {
            const shouldColorize = Settings.useSettings(() => Settings.get("colorGuildSettings", true));
            const color = useMemberColor(user.id);

            return (
                <span style={{
                    color: shouldColorize && color
                }}>{children}</span>
            );
        }

        if (!UserHook) return;

        Injector.inject({
            module: UserHook.prototype,
            method: "render",
            after(_, __, ret) {
                const tree = ret?.props?.children;
                if (!Array.isArray(tree)) return;

                tree[0] = (
                    <ColorizedAuditLogUsername user={this.props.user}>
                        {tree[0].props.children}
                    </ColorizedAuditLogUsername>
                );
            }
        });

        const forceUpdate = this.updateElements.bind(this, userHookClass);

        forceUpdate();
        this.flush.push(forceUpdate);
    }

    async patchGuildStickerCard() {
        const GuildStickerCard = Webpack.findByDisplayName("GuildStickerCard", {default: true});

        function ColoredStickerAuthor({user, ...props}) {
            const shouldColorize = Settings.useSettings(() => Settings.get("colorGuildSettings", true));
            const color = useMemberColor(user.id);

            return (
                <Text
                    style={{
                        color: shouldColorize && color
                    }}
                    {...props}
                />
            );
        }

        Injector.inject({
            module: GuildStickerCard,
            method: "default",
            after(_, [props], ret) {
                const originalChildren = ret.props.children;
                
                if (typeof originalChildren !== "function" || !props.sticker?.user) return;

                ret.props.children = function () {
                    const rendered = originalChildren.apply(this, arguments);

                    try {
                        const userElement = ReactTools.findInReactTree(rendered, e => e?.className?.indexOf("user-") > -1);
                        if (!Array.isArray(userElement?.children)) return rendered;

                        const username = userElement.children[1];
                        username.type = ColoredStickerAuthor;
                        username.props.user = props.sticker.user;
                    } catch (error) {
                        Logger.error("Failed to colorize sticker username:", error);
                    }

                    return rendered;
                };
            }
        });
    }

    async patchUserMention() {
        const MentionContext = React.createContext({isUserMention: false, userId: "", channelId: ""});
        const [
            UserMention,
            Mention,
            SlateComponents
        ] = Webpack.bulk(
            Webpack.Filters.byDisplayName("UserMention", true),
            Webpack.Filters.byDisplayName("Mention", true),
            ["UserMention"]
        );

        
        Injector.inject({
            module: Mention,
            method: "default",
            after(_, __, ret) {
                const {channelId, userId, isUserMention} = useContext(MentionContext);
                const color = useMemberColor(userId, ChannelStore.getChannel(channelId)?.guild_id);
                const shouldColorize = Settings.useSettings(() => Settings.get("colorMentions", true));

                if (!shouldColorize || !isUserMention || !color) return;

                ret.props.style = {
                    "--role-color-dimmed": ColorConverter.int2rgba(ColorConverter.hex2int(color), 0.1),
                    "--role-color": color
                };
            }
        });

        Injector.inject({
            module: UserMention,
            method: "default",
            after(_, [props], ret) {
                const context = {
                    ...props, 
                    isUserMention: true
                };

                return (
                    <MentionContext.Provider value={context}>
                        {ret}
                    </MentionContext.Provider>
                );
            }
        });

        Injector.inject({
            module: SlateComponents,
            method: "UserMention",
            after(_, [props], ret) {
                const context = {
                    userId: props.id,
                    channelId: props.channel?.id,
                    isUserMention: true
                };

                return (
                    <MentionContext.Provider value={context}>
                        {ret}
                    </MentionContext.Provider>
                );
            }
        });
    }

    async patchVoiceUser() {
        const [
            VoiceUser,
            voiceUserClasses
        ] = Webpack.bulk(
            "VoiceUser",
            ["iconPriortySpeaker", "voiceUser"]
        );
        
        function ColorizedVoiceUser({user, className, guildId, children}) {
            const shouldColorize = Settings.useSettings(() => Settings.get("colorVoiceUsers", true));
            const color = useMemberColor(user.id, guildId);

            return (
                <div
                    className={className}
                    style={{
                        color: shouldColorize && color
                    }}
                >{children}</div>
            );
        }
        
        Injector.inject({
            module: VoiceUser.prototype,
            method: "renderName",
            after(_, __, ret) {
                Object.assign(ret.props, {
                    user: this.props.user,
                    guildId: this.props.guildId
                });

                ret.type = ColorizedVoiceUser;
            }
        });

        const forceUpdate = this.updateElements.bind(this, voiceUserClasses?.voiceUser);

        this.flush.push(forceUpdate);

        forceUpdate();
    }

    async patchTypingUsers() {
        const [
            ConnectedTypingUsers,
            typingClasses
        ] = Webpack.bulk(
            "FluxContainer(TypingUsers)",
            ["typing"]
        );

        const TypingUsers = (() => {
            try {
                const rendered = ConnectedTypingUsers.prototype.render.call({memoizedGetStateFromStores: () => null});

                return rendered.type;
            } catch (error) {
                Logger.error("Failed to extract nested typing users component:", error);
            }
        })();

        function ColorizedTypingUser({user, channel, children}) {
            const shouldColorize = Settings.useSettings(() => Settings.get("colorTypingUsers", true));
            const color = useMemberColor(user.id, channel?.guild_id);

            return (
                <span
                    data-user-id={user.id}
                    style={{
                        color: shouldColorize && color
                    }}
                >{children}</span>
            );
        }

        Injector.inject({
            module: TypingUsers.prototype,
            method: "render",
            after(_, __, ret) {
                const currentUser = UserStore.getCurrentUser();

                const typingUsers = Object.keys(this.props.typingUsers ?? {});
                const tree: any[] = ret?.props?.children?.[1]?.props?.children;

                if (!tree || typingUsers.length === 0) return;
                for (let i = 0, offset = 0; i < typingUsers.length; i++) {
                    const user = UserStore.getUser(typingUsers[i]);
                    if (!user || user.id === currentUser.id || RelationshipStore.isBlocked(user.id)) {
                        offset++;
                        continue;
                    }

                    const child = tree[(i + offset) * 2];
                    if (!Array.isArray(child?.props?.children)) continue;

                    child.props.children = (
                        <ColorizedTypingUser user={user} channel={this.props.channel}>
                            {child.props.children}
                        </ColorizedTypingUser>
                    );
                }
            }
        });

        const forceUpdate = this.updateElements.bind(this, typingClasses.typing);

        this.flush.push(forceUpdate);

        forceUpdate();
    }

    updateElements(classNames: string) {
        const elements = document.getElementsByClassName(classNames);

        for (let i = 0; i < elements.length; i++) {
            const instance = ReactTools.getOwnerInstance(elements[i]);
            if (!instance) return;

            instance.forceUpdate();
        }
    }

    onStop(): void {
        Settings.unmount();

        for (let i = 0; i < this.flush.length; i++) {
            this.flush[i]();
        }
    }
}